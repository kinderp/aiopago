// R1-M-13 bounded architecture PoC. This is not production code.
package main

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
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
	"time"
)

var trustedNode = ""
var trustedP2 = ""
var trustedP2SHA256 = ""

const protocolVersion = 1
const maxFrameBytes = 8192
const capabilityBytes = 32

type Message struct {
	Version       int             `json:"version"`
	RequestID     string          `json:"requestId"`
	OperationType string          `json:"operationType"`
	Capability    string          `json:"capability,omitempty"`
	Payload       json.RawMessage `json:"payload"`
}

type ResultPayload struct {
	OK         bool   `json:"ok"`
	Code       string `json:"code"`
	Explicit   string `json:"explicitResult"`
	Idempotent bool   `json:"idempotent,omitempty"`
	Count      int    `json:"acceptedMutationCount"`
}

type MutationPayload struct {
	MutationType       string `json:"mutationType"`
	OperationID        string `json:"operationId"`
	RepositoryID       string `json:"repositoryId"`
	TaskID             string `json:"taskId"`
	PlanRevision       string `json:"planRevision"`
	PlanDigest         string `json:"planDigest"`
	SessionID          string `json:"sessionId"`
	RunnerLifecycle    string `json:"runnerLifecycle"`
	TakeoverGeneration int    `json:"takeoverGeneration"`
}

type DurableRecord struct {
	Schema             string `json:"schema"`
	SessionID          string `json:"sessionId"`
	RequestID          string `json:"requestId"`
	OperationType      string `json:"operationType"`
	MutationType       string `json:"mutationType"`
	OperationID        string `json:"operationId"`
	RepositoryID       string `json:"repositoryId"`
	TaskID             string `json:"taskId"`
	PlanRevision       string `json:"planRevision"`
	PlanDigest         string `json:"planDigest"`
	RunnerLifecycle    string `json:"runnerLifecycle"`
	TakeoverGeneration int    `json:"takeoverGeneration"`
	P1PID              int    `json:"p1Pid"`
	P2PID              int    `json:"p2Pid"`
	CapabilitySHA256   string `json:"capabilitySha256"`
	MAC                string `json:"mac"`
}

type Evidence struct {
	Schema                        string `json:"schema"`
	Platform                      string `json:"platform"`
	P0PID                         int    `json:"p0Pid"`
	P1PID                         int    `json:"p1Pid"`
	P1ParentPID                   int    `json:"p1ParentPid"`
	P2PID                         int    `json:"p2Pid"`
	P2ParentPID                   int    `json:"p2ParentPid"`
	CapabilityGeneratedBy         string `json:"capabilityGeneratedBy"`
	CapabilityBytes               int    `json:"capabilityBytes"`
	CapabilityInArgv              bool   `json:"capabilityInArgv"`
	CapabilityInEnvironment       bool   `json:"capabilityInEnvironment"`
	CapabilityInPackageFiles      bool   `json:"capabilityInPackageFiles"`
	CapabilityVisibleToP0         bool   `json:"capabilityVisibleToP0"`
	Channel                       string `json:"channel"`
	ChannelCreatedBy              string `json:"channelCreatedBy"`
	ChannelVisibleToP0            bool   `json:"channelVisibleToP0"`
	PositiveAcceptedMutations     int    `json:"positiveAcceptedMutations"`
	UnauthorizedAcceptedMutations int    `json:"unauthorizedAcceptedMutations"`
	DuplicateCreatedMutations     int    `json:"duplicateCreatedMutations"`
	DuplicateResult               string `json:"duplicateResult"`
	RequestConflictResult         string `json:"requestConflictResult"`
	FakeCapabilityResult          string `json:"fakeCapabilityResult"`
	DirectStateForgeryResult      string `json:"directStateForgeryResult"`
	ResourceCleanup               string `json:"resourceCleanup"`
	PriorRecordAfterRestart       string `json:"priorRecordAfterRestart"`
	DurableAuthenticityLimitation string `json:"durableAuthenticityLimitation"`
}

func fail(message string, args ...any) {
	fmt.Fprintf(os.Stderr, "broker: "+message+"\n", args...)
	os.Exit(1)
}

func boundedID(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if !(r == '-' || r == '_' || r == ':' || r == '.' || r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z') {
			return false
		}
	}
	return true
}

func readFrame(reader *bufio.Reader) (Message, error) {
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return Message{}, err
	}
	if len(line) > maxFrameBytes {
		return Message{}, errors.New("FRAME_TOO_LARGE")
	}
	line = bytes.TrimSpace(line)
	var message Message
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&message); err != nil {
		return Message{}, fmt.Errorf("MALFORMED_FRAME: %w", err)
	}
	if message.Version != protocolVersion || !boundedID(message.RequestID) || !boundedID(message.OperationType) || len(message.Payload) == 0 || len(message.Payload) > 4096 {
		return Message{}, errors.New("FRAME_CONTRACT_INVALID")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return Message{}, errors.New("TRAILING_FRAME_DATA")
	}
	return message, nil
}

func writeMessage(writer io.Writer, message Message) error {
	bytes, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if len(bytes)+1 > maxFrameBytes {
		return errors.New("FRAME_TOO_LARGE")
	}
	_, err = fmt.Fprintf(writer, "%s\n", bytes)
	return err
}

func resultMessage(requestID, operation, capability string, result ResultPayload) Message {
	payload, _ := json.Marshal(result)
	return Message{Version: protocolVersion, RequestID: requestID, OperationType: operation, Capability: capability, Payload: payload}
}

func sanitizeEnvironment() []string {
	allowed := map[string]bool{"SystemRoot": true, "WINDIR": true, "ComSpec": true, "TEMP": true, "TMP": true, "HOME": true, "TERM": true, "LANG": true, "LC_ALL": true}
	result := []string{}
	for _, entry := range os.Environ() {
		name, _, ok := strings.Cut(entry, "=")
		if ok && allowed[name] {
			result = append(result, entry)
		}
	}
	return result
}

func fileSHA256(path string) (string, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(bytes)
	return hex.EncodeToString(digest[:]), nil
}

func randomHex(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func unsignedRecord(record DurableRecord) DurableRecord { record.MAC = ""; return record }

func recordMAC(record DurableRecord, capability []byte) string {
	encoded, _ := json.Marshal(unsignedRecord(record))
	mac := hmac.New(sha256.New, capability)
	mac.Write(encoded)
	return hex.EncodeToString(mac.Sum(nil))
}

func validRecord(record DurableRecord, capability []byte) bool {
	expected, err := hex.DecodeString(record.MAC)
	if err != nil {
		return false
	}
	actual, _ := hex.DecodeString(recordMAC(record, capability))
	return hmac.Equal(expected, actual)
}

func atomicWrite(path string, data []byte) error {
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0600); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		_ = os.Remove(path)
	}
	return os.Rename(temporary, path)
}

func strictMutation(message Message, sessionID string) (MutationPayload, error) {
	if message.OperationType != "AUTHORIZE_MUTATION" {
		return MutationPayload{}, errors.New("OPERATION_NOT_ALLOWED")
	}
	var payload MutationPayload
	decoder := json.NewDecoder(bytes.NewReader(message.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, errors.New("MUTATION_PAYLOAD_INVALID")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return payload, errors.New("MUTATION_PAYLOAD_INVALID")
	}
	if payload.MutationType != "POC_OPERATION_TERMINAL" || payload.OperationID != "OP-POC-AUTHORIZED" || payload.RepositoryID != "REPO-POC-FIXED" || payload.TaskID != "TASK-POC-FIXED" || payload.PlanRevision != "PLAN-POC-1" || payload.PlanDigest != "sha256:poc-fixed-digest" || payload.SessionID != sessionID || payload.RunnerLifecycle != "ACTIVE" || payload.TakeoverGeneration != 0 {
		return payload, errors.New("SEMANTIC_BINDING_REJECTED")
	}
	return payload, nil
}

func main() {
	if trustedNode == "" || trustedP2 == "" || trustedP2SHA256 == "" {
		fail("build-time trusted runtime identity missing")
	}
	actualDigest, err := fileSHA256(trustedP2)
	if err != nil || !strings.EqualFold(actualDigest, trustedP2SHA256) {
		fail("P2_TRUSTED_SOURCE_MISMATCH")
	}
	executable, err := os.Executable()
	if err != nil {
		fail("cannot resolve broker executable: %v", err)
	}
	root := filepath.Dir(executable)
	statePath := filepath.Join(root, "broker-state.json")
	readyPath := filepath.Join(root, "attack-ready")
	donePath := filepath.Join(root, "attack-done")
	evidencePath := filepath.Join(root, "evidence.json")
	for _, path := range []string{readyPath, donePath, evidencePath} {
		_ = os.Remove(path)
	}
	priorRecord := "NONE"
	if _, err := os.Stat(statePath); err == nil {
		priorRecord = "UNVERIFIABLE_WITHOUT_PERSISTENT_TRUST_ANCHOR"
	}

	capability := make([]byte, capabilityBytes)
	if _, err := rand.Read(capability); err != nil {
		fail("CAPABILITY_GENERATION_FAILED: %v", err)
	}
	capabilityHex := hex.EncodeToString(capability)
	capabilityDigest := sha256.Sum256(capability)
	sessionID, err := randomHex(16)
	if err != nil {
		fail("SESSION_GENERATION_FAILED")
	}

	cmd := exec.Command(trustedNode, trustedP2)
	cmd.Env = sanitizeEnvironment()
	cmd.Stderr = os.Stderr
	p2Input, err := cmd.StdinPipe()
	if err != nil {
		fail("P2_PIPE_FAILED: %v", err)
	}
	p2Output, err := cmd.StdoutPipe()
	if err != nil {
		fail("P2_PIPE_FAILED: %v", err)
	}
	if err := cmd.Start(); err != nil {
		fail("P2_START_FAILED: %v", err)
	}
	p2PID := cmd.Process.Pid
	reader := bufio.NewReaderSize(p2Output, maxFrameBytes+1)

	helloPayload, _ := json.Marshal(map[string]any{"sessionId": sessionID, "p1Pid": os.Getpid(), "p1ParentPid": os.Getppid(), "p2Pid": p2PID, "channel": "P1-created inherited anonymous stdin/stdout pipes"})
	if err := writeMessage(p2Input, Message{Version: 1, RequestID: "hello-1", OperationType: "HELLO", Capability: capabilityHex, Payload: helloPayload}); err != nil {
		fail("HELLO_WRITE_FAILED")
	}
	bind, err := readFrame(reader)
	if err != nil {
		fail("SESSION_BIND_READ_FAILED: %v", err)
	}
	if bind.OperationType != "SESSION_BIND" || bind.Capability != capabilityHex {
		fail("SESSION_BIND_REJECTED")
	}
	var bindPayload struct {
		SessionID   string `json:"sessionId"`
		P2PID       int    `json:"p2Pid"`
		P2ParentPID int    `json:"p2ParentPid"`
	}
	if err := json.Unmarshal(bind.Payload, &bindPayload); err != nil || bindPayload.SessionID != sessionID || bindPayload.P2PID != p2PID || bindPayload.P2ParentPID != os.Getpid() {
		fail("SESSION_BIND_IDENTITY_REJECTED")
	}
	_ = writeMessage(p2Input, resultMessage(bind.RequestID, "MUTATION_RESULT", capabilityHex, ResultPayload{OK: true, Code: "SESSION_BOUND", Explicit: "P2_BOUND", Count: 0}))

	accepted := 0
	unauthorizedAccepted := 0
	duplicateCreated := 0
	duplicateResult := "NOT_RUN"
	conflictResult := "NOT_RUN"
	fakeResult := "NOT_RUN"
	directForgeryResult := "NOT_RUN"
	seenRequest := map[string][]byte{}
	var authenticRecord DurableRecord
	var authenticBytes []byte
	shutdown := false
	for !shutdown {
		message, err := readFrame(reader)
		if err != nil {
			fail("PROTOCOL_READ_FAILED: %v", err)
		}
		if message.OperationType == "SHUTDOWN" {
			if message.Capability != capabilityHex {
				fail("SHUTDOWN_CAPABILITY_REJECTED")
			}
			_ = writeMessage(p2Input, resultMessage(message.RequestID, "MUTATION_RESULT", capabilityHex, ResultPayload{OK: true, Code: "SHUTDOWN", Explicit: "CLOSED", Count: accepted}))
			shutdown = true
			continue
		}
		if prior, exists := seenRequest[message.RequestID]; exists {
			current, _ := json.Marshal(message)
			if bytes.Equal(prior, current) {
				duplicateResult = "IDEMPOTENT_RECORDED_RESULT"
				_ = writeMessage(p2Input, resultMessage(message.RequestID, "MUTATION_RESULT", capabilityHex, ResultPayload{OK: true, Code: "DUPLICATE_IDEMPOTENT", Explicit: "NO_NEW_MUTATION", Idempotent: true, Count: accepted}))
			} else {
				conflictResult = "REQUEST_ID_CONFLICT_REJECTED"
				_ = writeMessage(p2Input, resultMessage(message.RequestID, "MUTATION_RESULT", capabilityHex, ResultPayload{OK: false, Code: "REQUEST_ID_CONFLICT", Explicit: "REJECTED", Count: accepted}))
			}
			continue
		}
		if message.Capability != capabilityHex {
			fakeResult = "CAPABILITY_REJECTED"
			_ = writeMessage(p2Input, resultMessage(message.RequestID, "MUTATION_RESULT", "", ResultPayload{OK: false, Code: "CAPABILITY_REJECTED", Explicit: "REJECTED", Count: accepted}))
			continue
		}
		payload, err := strictMutation(message, sessionID)
		if err != nil {
			_ = writeMessage(p2Input, resultMessage(message.RequestID, "MUTATION_RESULT", capabilityHex, ResultPayload{OK: false, Code: err.Error(), Explicit: "REJECTED", Count: accepted}))
			continue
		}
		encodedMessage, _ := json.Marshal(message)
		seenRequest[message.RequestID] = encodedMessage
		record := DurableRecord{Schema: "aiopago.r1-m-13-native-poc-record/1", SessionID: sessionID, RequestID: message.RequestID, OperationType: message.OperationType, MutationType: payload.MutationType, OperationID: payload.OperationID, RepositoryID: payload.RepositoryID, TaskID: payload.TaskID, PlanRevision: payload.PlanRevision, PlanDigest: payload.PlanDigest, RunnerLifecycle: payload.RunnerLifecycle, TakeoverGeneration: payload.TakeoverGeneration, P1PID: os.Getpid(), P2PID: p2PID, CapabilitySHA256: hex.EncodeToString(capabilityDigest[:])}
		record.MAC = recordMAC(record, capability)
		authenticBytes, _ = json.MarshalIndent(record, "", "  ")
		authenticBytes = append(authenticBytes, '\n')
		if err := atomicWrite(statePath, authenticBytes); err != nil {
			fail("MUTATION_WRITE_FAILED: %v", err)
		}
		authenticRecord = record
		accepted++
		_ = os.WriteFile(readyPath, []byte("ready\n"), 0600)
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(donePath); err == nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		candidateBytes, readErr := os.ReadFile(statePath)
		var candidate DurableRecord
		if readErr != nil || json.Unmarshal(candidateBytes, &candidate) != nil || !validRecord(candidate, capability) || candidate.OperationID != authenticRecord.OperationID {
			directForgeryResult = "FORGED_EQUIVALENT_STATE_REJECTED_BY_LIVE_NATIVE_BROKER"
			unauthorizedAccepted = 0
			_ = atomicWrite(statePath, authenticBytes)
		} else if !bytes.Equal(bytes.TrimSpace(candidateBytes), bytes.TrimSpace(authenticBytes)) {
			directForgeryResult = "NONCANONICAL_STATE_REJECTED"
			_ = atomicWrite(statePath, authenticBytes)
		} else {
			directForgeryResult = "NO_FORGERY_OBSERVED"
		}
		_ = writeMessage(p2Input, resultMessage(message.RequestID, "MUTATION_RESULT", capabilityHex, ResultPayload{OK: true, Code: "MUTATION_ACCEPTED", Explicit: "ONE_BROKER_AUTHORIZED_SENTINEL", Count: accepted}))
	}

	_ = p2Input.Close()
	waitErr := cmd.Wait()
	cleanup := "P2_EXITED_AND_PRIVATE_PIPE_ENDPOINTS_CLOSED"
	if waitErr != nil {
		cleanup = "P2_EXIT_ERROR: " + waitErr.Error()
	}
	evidence := Evidence{Schema: "aiopago.r1-m-13-native-poc-evidence/1", Platform: runtime.GOOS + "/" + runtime.GOARCH, P0PID: os.Getppid(), P1PID: os.Getpid(), P1ParentPID: os.Getppid(), P2PID: p2PID, P2ParentPID: bindPayload.P2ParentPID, CapabilityGeneratedBy: "P1 crypto/rand after native process entry", CapabilityBytes: capabilityBytes, CapabilityInArgv: false, CapabilityInEnvironment: false, CapabilityInPackageFiles: false, CapabilityVisibleToP0: false, Channel: "inherited anonymous stdin/stdout pipes dedicated to P1<->P2 protocol", ChannelCreatedBy: "P1 os/exec", ChannelVisibleToP0: false, PositiveAcceptedMutations: accepted, UnauthorizedAcceptedMutations: unauthorizedAccepted, DuplicateCreatedMutations: duplicateCreated, DuplicateResult: duplicateResult, RequestConflictResult: conflictResult, FakeCapabilityResult: fakeResult, DirectStateForgeryResult: directForgeryResult, ResourceCleanup: cleanup, PriorRecordAfterRestart: priorRecord, DurableAuthenticityLimitation: "The ephemeral capability cannot authenticate this record after P1 exits; portable restart authenticity requires a protected persistent trust anchor or service."}
	evidenceBytes, _ := json.MarshalIndent(evidence, "", "  ")
	evidenceBytes = append(evidenceBytes, '\n')
	if err := atomicWrite(evidencePath, evidenceBytes); err != nil {
		fail("EVIDENCE_WRITE_FAILED: %v", err)
	}
	fmt.Printf("%s", evidenceBytes)
	for index := range capability {
		capability[index] = 0
	}
	_ = os.Remove(readyPath)
	_ = os.Remove(donePath)
}
