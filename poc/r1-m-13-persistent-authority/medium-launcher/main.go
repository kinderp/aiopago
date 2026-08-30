// Launches one test process with a duplicate of the existing Explorer primary token.
// This is used only so an elevated oracle does not accidentally test P0 as administrator.
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var createProcessWithTokenW = windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateProcessWithTokenW")

func quote(value string) string { return syscall.EscapeArg(value) }

func withToken(token windows.Token, application, commandLine, directory string, startup *windows.StartupInfo, process *windows.ProcessInformation) error {
	app, _ := windows.UTF16PtrFromString(application)
	command, _ := windows.UTF16FromString(commandLine)
	cwd, _ := windows.UTF16PtrFromString(directory)
	result, _, callErr := createProcessWithTokenW.Call(
		uintptr(token), 1, uintptr(unsafe.Pointer(app)), uintptr(unsafe.Pointer(&command[0])),
		windows.CREATE_UNICODE_ENVIRONMENT, 0, uintptr(unsafe.Pointer(cwd)),
		uintptr(unsafe.Pointer(startup)), uintptr(unsafe.Pointer(process)),
	)
	if result == 0 {
		return callErr
	}
	return nil
}

func main() {
	if len(os.Args) < 4 {
		fmt.Fprintln(os.Stderr, "usage: medium-token-launcher <explorer-pid> <application> <args...>")
		os.Exit(2)
	}
	pid64, err := strconv.ParseUint(os.Args[1], 10, 32)
	if err != nil {
		panic(err)
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid64))
	if err != nil {
		panic(err)
	}
	defer windows.CloseHandle(process)
	var explorerToken windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_ASSIGN_PRIMARY, &explorerToken); err != nil {
		panic(err)
	}
	defer explorerToken.Close()
	var primary windows.Token
	if err := windows.DuplicateTokenEx(explorerToken, windows.MAXIMUM_ALLOWED, nil, windows.SecurityImpersonation, windows.TokenPrimary, &primary); err != nil {
		panic(err)
	}
	defer primary.Close()
	application := os.Args[2]
	parts := []string{quote(application)}
	for _, arg := range os.Args[3:] {
		parts = append(parts, quote(arg))
	}
	commandLine := strings.Join(parts, " ")
	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	startup := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{}))}
	var child windows.ProcessInformation
	appPtr, _ := windows.UTF16PtrFromString(application)
	command, _ := windows.UTF16FromString(commandLine)
	cwdPtr, _ := windows.UTF16PtrFromString(cwd)
	err = windows.CreateProcessAsUser(primary, appPtr, &command[0], nil, nil, false, windows.CREATE_UNICODE_ENVIRONMENT, nil, cwdPtr, &startup, &child)
	if err != nil {
		err = withToken(primary, application, commandLine, cwd, &startup, &child)
	}
	if err != nil {
		panic(err)
	}
	defer windows.CloseHandle(child.Process)
	defer windows.CloseHandle(child.Thread)
	fmt.Printf("P0_PID=%d EXPLORER_PID=%d\n", child.ProcessId, pid64)
	_, err = windows.WaitForSingleObject(child.Process, windows.INFINITE)
	if err != nil {
		panic(err)
	}
	var exit uint32
	if err := windows.GetExitCodeProcess(child.Process, &exit); err != nil {
		panic(err)
	}
	os.Exit(int(exit))
}
