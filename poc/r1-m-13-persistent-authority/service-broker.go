// R1-M-13 distinct-identity restart/crash oracle. Non-production Windows PoC.
package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"golang.org/x/sys/windows/svc"
)

const (
	serviceName     = "AiopagoR1M13Poc"
	protocolVersion = 1
	maxFrameBytes   = 8192
)

type recordCore struct {
	Sequence       int    `json:"sequence"`
	RequestID      string `json:"requestId"`
	OperationType  string `json:"operationType"`
	PayloadDigest  string `json:"payloadDigest"`
	PreviousDigest string `json:"previousDigest"`
}

type signedRecord struct {
	Sequence       int    `json:"sequence"`
	RequestID      string `json:"requestId"`
	OperationType  string `json:"operationType"`
	PayloadDigest  string `json:"payloadDigest"`
	PreviousDigest string `json:"previousDigest"`
	RecordDigest   string `json:"recordDigest"`
	Signature      string `json:"signature"`
}

type canonicalState struct {
	Schema      string         `json:"schema"`
	PublicKey   string         `json:"publicKey"`
	Fingerprint string         `json:"fingerprint"`
	Sequence    int            `json:"sequence"`
	Records     []signedRecord `json:"records"`
}

type frame struct {
	Version       int            `json:"version"`
	RequestID     string         `json:"requestId"`
	OperationType string         `json:"operationType"`
	Capability    string         `json:"capability,omitempty"`
	Payload       map[string]any `json:"payload"`
}

type mutationResult struct {
	OK       bool   `json:"ok"`
	Code     string `json:"code"`
	Sequence int    `json:"sequence"`
	Digest   string `json:"digest,omitempty"`
}

type phaseEvidence struct {
	Schema                        string `json:"schema"`
	Mode                          string `json:"mode"`
	PID                           int    `json:"pid"`
	ParentPID                     int    `json:"parentPid"`
	P2PID                         int    `json:"p2Pid,omitempty"`
	WhoamiAll                     string `json:"whoamiAll"`
	Fingerprint                   string `json:"fingerprint"`
	LoadedSequence                int    `json:"loadedSequence"`
	FinalSequence                 int    `json:"finalSequence"`
	CanonicalSHA256               string `json:"canonicalSha256"`
	ProjectionBeforeSHA256        string `json:"projectionBeforeSha256,omitempty"`
	ProjectionConsumedAsCanonical bool   `json:"projectionConsumedAsCanonical"`
	FirstResult                   string `json:"firstResult,omitempty"`
	DuplicateResult               string `json:"duplicateResult,omitempty"`
	ConflictResult                string `json:"conflictResult,omitempty"`
	PrivateChannel                string `json:"privateChannel,omitempty"`
	CapabilityInArgv              bool   `json:"capabilityInArgv"`
	CapabilityInEnvironment       bool   `json:"capabilityInEnvironment"`
	CrashPoint                    string `json:"crashPoint,omitempty"`
	TemporaryStateSHA256          string `json:"temporaryStateSha256,omitempty"`
	UncommittedTemporaryAccepted  bool   `json:"uncommittedTemporaryAccepted"`
	StaleTemporaryFound           bool   `json:"staleTemporaryFound,omitempty"`
	StaleTemporaryValid           bool   `json:"staleTemporaryValid,omitempty"`
	Result                        string `json:"result"`
}

type serviceHandler struct{}

func sha(data []byte) string { d := sha256.Sum256(data); return hex.EncodeToString(d[:]) }
func payloadDigest(operation, payload string) string {
	return sha([]byte(operation + "\x00" + payload))
}
func coreDigest(core recordCore) string { data, _ := json.Marshal(core); return sha(data) }

func atomicWrite(path string, data []byte) error {
	temporary := path + ".next"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func writeFlushed(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err
}

func readMode(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "control", "mode.txt"))
	if err != nil {
		return "", err
	}
	mode := strings.TrimSpace(string(data))
	switch mode {
	case "before", "after", "crash", "recover":
		return mode, nil
	}
	return "", fmt.Errorf("unsupported mode %q", mode)
}

func keyAndState(root string) (ed25519.PrivateKey, canonicalState, bool, error) {
	canonical := filepath.Join(root, "canonical")
	keyPath := filepath.Join(canonical, "identity.ed25519")
	statePath := filepath.Join(canonical, "state.json")
	keyBytes, keyErr := os.ReadFile(keyPath)
	stateBytes, stateErr := os.ReadFile(statePath)
	if errors.Is(keyErr, os.ErrNotExist) && errors.Is(stateErr, os.ErrNotExist) {
		public, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, canonicalState{}, false, err
		}
		fingerprint := sha(public)
		state := canonicalState{Schema: "aiopago.r1-m-13-canonical/1", PublicKey: base64.StdEncoding.EncodeToString(public), Fingerprint: fingerprint, Sequence: 0, Records: []signedRecord{}}
		encoded, _ := json.MarshalIndent(state, "", "  ")
		encoded = append(encoded, '\n')
		if err := writeFlushed(keyPath, private); err != nil {
			return nil, canonicalState{}, false, err
		}
		if err := atomicWrite(statePath, encoded); err != nil {
			return nil, canonicalState{}, false, err
		}
		return private, state, true, nil
	}
	if keyErr != nil || stateErr != nil {
		return nil, canonicalState{}, false, fmt.Errorf("key/state pair incomplete: key=%v state=%v", keyErr, stateErr)
	}
	if len(keyBytes) != ed25519.PrivateKeySize {
		return nil, canonicalState{}, false, errors.New("private key length invalid")
	}
	private := ed25519.PrivateKey(keyBytes)
	var state canonicalState
	decoder := json.NewDecoder(bytes.NewReader(stateBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return nil, canonicalState{}, false, errors.New("canonical state malformed")
	}
	if err := validateState(state, private.Public().(ed25519.PublicKey)); err != nil {
		return nil, canonicalState{}, false, err
	}
	return private, state, false, nil
}

func validateState(state canonicalState, public ed25519.PublicKey) error {
	if state.Schema != "aiopago.r1-m-13-canonical/1" || state.PublicKey != base64.StdEncoding.EncodeToString(public) || state.Fingerprint != sha(public) || state.Sequence != len(state.Records) {
		return errors.New("canonical identity/sequence invalid")
	}
	previous := "GENESIS"
	for index, record := range state.Records {
		core := recordCore{Sequence: record.Sequence, RequestID: record.RequestID, OperationType: record.OperationType, PayloadDigest: record.PayloadDigest, PreviousDigest: record.PreviousDigest}
		digest := coreDigest(core)
		signature, err := base64.StdEncoding.DecodeString(record.Signature)
		if err != nil || record.Sequence != index+1 || record.PreviousDigest != previous || record.RecordDigest != digest || !ed25519.Verify(public, []byte(digest), signature) {
			return fmt.Errorf("canonical record %d invalid", index+1)
		}
		previous = digest
	}
	return nil
}

func encodeState(state canonicalState) []byte {
	data, _ := json.MarshalIndent(state, "", "  ")
	return append(data, '\n')
}

func nextState(state canonicalState, private ed25519.PrivateKey, requestID, operation, payload string) canonicalState {
	previous := "GENESIS"
	if len(state.Records) > 0 {
		previous = state.Records[len(state.Records)-1].RecordDigest
	}
	core := recordCore{Sequence: state.Sequence + 1, RequestID: requestID, OperationType: operation, PayloadDigest: payloadDigest(operation, payload), PreviousDigest: previous}
	digest := coreDigest(core)
	record := signedRecord{Sequence: core.Sequence, RequestID: core.RequestID, OperationType: core.OperationType, PayloadDigest: core.PayloadDigest, PreviousDigest: core.PreviousDigest, RecordDigest: digest, Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, []byte(digest)))}
	state.Sequence++
	state.Records = append(state.Records, record)
	return state
}

func applyMutation(root, mode string, state canonicalState, private ed25519.PrivateKey, requestID, operation, payload string) (canonicalState, mutationResult, error) {
	digest := payloadDigest(operation, payload)
	for _, record := range state.Records {
		if record.RequestID == requestID {
			if record.OperationType == operation && record.PayloadDigest == digest {
				return state, mutationResult{OK: true, Code: "IDEMPOTENT_RECORDED_RESULT", Sequence: state.Sequence, Digest: record.RecordDigest}, nil
			}
			return state, mutationResult{OK: false, Code: "REQUEST_ID_CONFLICT", Sequence: state.Sequence}, nil
		}
	}
	next := nextState(state, private, requestID, operation, payload)
	encoded := encodeState(next)
	statePath := filepath.Join(root, "canonical", "state.json")
	if mode == "crash" {
		temporary := statePath + ".next"
		if err := writeFlushed(temporary, encoded); err != nil {
			return state, mutationResult{}, err
		}
		marker := phaseEvidence{Schema: "aiopago.r1-m-13-service-phase/1", Mode: mode, PID: os.Getpid(), ParentPID: os.Getppid(), Fingerprint: state.Fingerprint, LoadedSequence: state.Sequence, FinalSequence: state.Sequence, CanonicalSHA256: sha(encodeState(state)), ProjectionConsumedAsCanonical: false, CrashPoint: "AFTER_COMPLETE_TEMPORARY_WRITE_BEFORE_ATOMIC_REPLACE", TemporaryStateSHA256: sha(encoded), UncommittedTemporaryAccepted: false, Result: "INTENTIONAL_ABRUPT_TERMINATION"}
		markerBytes, _ := json.MarshalIndent(marker, "", "  ")
		markerBytes = append(markerBytes, '\n')
		_ = writeFlushed(filepath.Join(root, "test-output", "phase-crash-marker.json"), markerBytes)
		os.Exit(97)
	}
	if err := atomicWrite(statePath, encoded); err != nil {
		return state, mutationResult{}, err
	}
	last := next.Records[len(next.Records)-1]
	return next, mutationResult{OK: true, Code: "MUTATION_ACCEPTED", Sequence: next.Sequence, Digest: last.RecordDigest}, nil
}

func exportProjection(path string, state canonicalState) error {
	projection := struct {
		Schema         string         `json:"schema"`
		Fingerprint    string         `json:"fingerprint"`
		PublicKey      string         `json:"publicKey"`
		Sequence       int            `json:"sequence"`
		Records        []signedRecord `json:"records"`
		CanonicalInput bool           `json:"canonicalInput"`
	}{Schema: "aiopago.r1-m-13-public-projection/1", Fingerprint: state.Fingerprint, PublicKey: state.PublicKey, Sequence: state.Sequence, Records: state.Records, CanonicalInput: false}
	return atomicWrite(path, encodeProjection(projection))
}

func encodeProjection(value any) []byte {
	data, _ := json.MarshalIndent(value, "", "  ")
	return append(data, '\n')
}

func frameWrite(writer io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data)+1 > maxFrameBytes {
		return errors.New("frame too large")
	}
	_, err = fmt.Fprintf(writer, "%s\n", data)
	return err
}
func frameRead(reader *bufio.Reader) (frame, error) {
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return frame{}, err
	}
	if len(line) > maxFrameBytes {
		return frame{}, errors.New("frame too large")
	}
	var value frame
	decoder := json.NewDecoder(bytes.NewReader(bytes.TrimSpace(line)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return frame{}, err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return frame{}, errors.New("trailing data")
	}
	return value, nil
}

func randomCapability() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}
func cleanEnvironment() []string {
	allowed := map[string]bool{"SystemRoot": true, "WINDIR": true, "ComSpec": true, "TEMP": true, "TMP": true}
	var result []string
	for _, entry := range os.Environ() {
		name, _, ok := strings.Cut(entry, "=")
		if ok && allowed[name] {
			result = append(result, entry)
		}
	}
	return result
}

func runP2(root, mode string, state canonicalState, private ed25519.PrivateKey) (canonicalState, int, string, string, string, error) {
	node := filepath.Join(root, "bin", "node.exe")
	script := filepath.Join(root, "bin", "p2-service-runtime.mjs")
	operationID := map[string]string{"before": "OP-POC-BEFORE-RESTART", "after": "OP-POC-AFTER-RESTART", "crash": "OP-POC-CRASH-TEMP"}[mode]
	payload := map[string]string{"before": "before-restart", "after": "after-restart", "crash": "crash-temp"}[mode]
	capability, err := randomCapability()
	if err != nil {
		return state, 0, "", "", "", err
	}
	cmd := exec.Command(node, script)
	cmd.Env = cleanEnvironment()
	var p2Stderr bytes.Buffer
	cmd.Stderr = &p2Stderr
	input, err := cmd.StdinPipe()
	if err != nil {
		return state, 0, "", "", "", err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		return state, 0, "", "", "", err
	}
	if err := cmd.Start(); err != nil {
		return state, 0, "", "", "", err
	}
	p2PID := cmd.Process.Pid
	reader := bufio.NewReaderSize(output, maxFrameBytes+1)
	hello := frame{Version: protocolVersion, RequestID: "hello-1", OperationType: "HELLO", Capability: capability, Payload: map[string]any{"mode": mode, "operationId": operationID, "semanticOperation": "POC_OPERATION_TERMINAL", "payload": payload, "p1Pid": os.Getpid(), "p2Pid": p2PID}}
	if err := frameWrite(input, hello); err != nil {
		return state, p2PID, "", "", "", err
	}
	results := []string{}
	var result mutationResult
	for index := 0; index < 3; index++ {
		request, err := frameRead(reader)
		if err != nil {
			return state, p2PID, "", "", "", fmt.Errorf("P2_FRAME_READ: %w; stderr=%s", err, strings.TrimSpace(p2Stderr.String()))
		}
		if request.Version != protocolVersion || request.Capability != capability || request.OperationType != "POC_OPERATION_TERMINAL" || request.RequestID != operationID {
			return state, p2PID, "", "", "", errors.New("private semantic request rejected")
		}
		requestPayload, ok := request.Payload["value"].(string)
		if !ok {
			return state, p2PID, "", "", "", errors.New("payload rejected")
		}
		state, result, err = applyMutation(root, mode, state, private, request.RequestID, request.OperationType, requestPayload)
		if err != nil {
			return state, p2PID, "", "", "", err
		}
		results = append(results, result.Code)
		if err := frameWrite(input, frame{Version: protocolVersion, RequestID: request.RequestID, OperationType: "MUTATION_RESULT", Payload: map[string]any{"ok": result.OK, "code": result.Code, "sequence": result.Sequence, "digest": result.Digest}}); err != nil {
			return state, p2PID, "", "", "", err
		}
	}
	_ = input.Close()
	if err := cmd.Wait(); err != nil {
		return state, p2PID, "", "", "", err
	}
	return state, p2PID, results[0], results[1], results[2], nil
}

func phase(root, mode string) (phaseEvidence, error) {
	projectionPathData, err := os.ReadFile(filepath.Join(root, "control", "projection-path.txt"))
	if err != nil {
		return phaseEvidence{}, err
	}
	projectionPath := strings.TrimSpace(string(projectionPathData))
	whoamiBytes, whoamiErr := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "whoami.exe"), "/all").CombinedOutput()
	if whoamiErr != nil {
		whoamiBytes = append(whoamiBytes, []byte("\nWHOAMI_ERROR: "+whoamiErr.Error())...)
	}
	projectionBefore := ""
	if data, err := os.ReadFile(projectionPath); err == nil {
		projectionBefore = sha(data)
	}
	private, state, _, err := keyAndState(root)
	if err != nil {
		return phaseEvidence{}, err
	}
	loaded := state.Sequence
	evidence := phaseEvidence{Schema: "aiopago.r1-m-13-service-phase/1", Mode: mode, PID: os.Getpid(), ParentPID: os.Getppid(), WhoamiAll: string(whoamiBytes), Fingerprint: state.Fingerprint, LoadedSequence: loaded, ProjectionBeforeSHA256: projectionBefore, ProjectionConsumedAsCanonical: false, CapabilityInArgv: false, CapabilityInEnvironment: false, Result: "PASS"}
	expected := map[string]int{"before": 0, "after": 1, "crash": 2, "recover": 2}[mode]
	if loaded != expected {
		return evidence, fmt.Errorf("mode %s expected sequence %d, found %d", mode, expected, loaded)
	}
	statePath := filepath.Join(root, "canonical", "state.json")
	stalePath := statePath + ".next"
	if mode == "recover" {
		if data, err := os.ReadFile(stalePath); err == nil {
			evidence.StaleTemporaryFound = true
			var candidate canonicalState
			if json.Unmarshal(data, &candidate) == nil && validateState(candidate, private.Public().(ed25519.PublicKey)) == nil {
				evidence.StaleTemporaryValid = true
			}
			_ = os.Remove(stalePath)
		}
	} else {
		var p2 int
		var first, duplicate, conflict string
		state, p2, first, duplicate, conflict, err = runP2(root, mode, state, private)
		if err != nil {
			return evidence, err
		}
		evidence.P2PID = p2
		evidence.FirstResult = first
		evidence.DuplicateResult = duplicate
		evidence.ConflictResult = conflict
		evidence.PrivateChannel = "P1S-created inherited anonymous stdin/stdout pipes; no named semantic endpoint"
	}
	if err := validateState(state, private.Public().(ed25519.PublicKey)); err != nil {
		return evidence, err
	}
	if err := exportProjection(projectionPath, state); err != nil {
		return evidence, err
	}
	canonicalBytes, err := os.ReadFile(statePath)
	if err != nil {
		return evidence, err
	}
	evidence.FinalSequence = state.Sequence
	evidence.CanonicalSHA256 = sha(canonicalBytes)
	evidence.UncommittedTemporaryAccepted = false
	return evidence, nil
}

func writePhaseEvidence(root string, evidence phaseEvidence) error {
	data, _ := json.MarshalIndent(evidence, "", "  ")
	data = append(data, '\n')
	return atomicWrite(filepath.Join(root, "test-output", fmt.Sprintf("phase-%s.json", evidence.Mode)), data)
}

func (serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	executable, err := os.Executable()
	if err != nil {
		return false, 1
	}
	root := filepath.Dir(filepath.Dir(executable))
	mode, err := readMode(root)
	if err != nil {
		return false, 2
	}
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	evidence, err := phase(root, mode)
	if err != nil {
		evidence.Result = "FAIL: " + err.Error()
		if evidence.Mode == "" {
			evidence.Mode = mode
		}
		_ = writePhaseEvidence(root, evidence)
		return false, 3
	}
	if err := writePhaseEvidence(root, evidence); err != nil {
		return false, 4
	}
	for request := range requests {
		switch request.Cmd {
		case svc.Interrogate:
			status <- request.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			return false, 0
		}
	}
	return false, 0
}

func main() {
	if runtime.GOOS != "windows" {
		fmt.Fprintln(os.Stderr, "WINDOWS_ONLY_POC")
		os.Exit(2)
	}
	if err := svc.Run(serviceName, serviceHandler{}); err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		os.Exit(1)
	}
}
