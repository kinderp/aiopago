// Windows P1S host for the bounded production operation-authority domain.
// Compile with the inbox .NET Framework csc; no NuGet or downloaded runtime.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Aiopago.OperationAuthority {
  internal static class Program {
    internal const string Protocol = "aiopago.operation-authority-protocol/2";
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 262144, RecursionLimit = 32 };

    public static int Main(string[] args) {
      try {
        if (args.Length >= 4 && args[0] == "--sentinel") {
          ServiceBase.Run(new ServiceBase[] { new SentinelService(args[1], args[2], args[3]) });
          return 0;
        }
        string config = Option(args, "--config");
        if (String.IsNullOrWhiteSpace(config)) throw new InvalidOperationException("CONFIG_REQUIRED");
        config = Path.GetFullPath(config);
        string serviceName = Text(ReadObject(config), "serviceName");
        ServiceBase.Run(new ServiceBase[] { new AuthorityService(config, serviceName) });
        return 0;
      } catch (Exception error) {
        Console.Error.WriteLine("operation-authority-service: " + error.GetType().Name + ": " + error.Message);
        return 2;
      }
    }

    internal static string Option(string[] args, string name) {
      for (int i = 0; i + 1 < args.Length; ++i) if (args[i] == name) return args[i + 1];
      return null;
    }

    internal static Dictionary<string, object> ReadObject(string path) {
      object value = Json.DeserializeObject(File.ReadAllText(path, Encoding.UTF8));
      Dictionary<string, object> result = value as Dictionary<string, object>;
      if (result == null) throw new InvalidDataException("JSON_OBJECT_REQUIRED: " + path);
      return result;
    }

    internal static string Text(Dictionary<string, object> value, string key) {
      object found;
      if (!value.TryGetValue(key, out found) || !(found is string) || String.IsNullOrWhiteSpace((string)found)) throw new InvalidDataException(key + "_INVALID");
      return (string)found;
    }

    internal static bool Bool(Dictionary<string, object> value, string key) {
      object found;
      if (!value.TryGetValue(key, out found) || !(found is bool)) throw new InvalidDataException(key + "_INVALID");
      return (bool)found;
    }

    internal static string Sha256File(string path) {
      using (SHA256 digest = SHA256.Create())
      using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        return String.Concat(digest.ComputeHash(stream).Select(b => b.ToString("x2")));
      }
    }

    internal static string Sha256Bytes(byte[] value) {
      using (SHA256 digest = SHA256.Create()) return String.Concat(digest.ComputeHash(value).Select(b => b.ToString("x2")));
    }

    internal static void AtomicJson(string path, object value) {
      string temporary = path + ".next";
      byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(value) + Environment.NewLine);
      using (FileStream stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
        stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
      }
      if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
    }

    internal static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
  }

  internal sealed class AuthorityService : ServiceBase {
    private readonly string configPath;
    private readonly ManualResetEvent stopped = new ManualResetEvent(false);
    private Process worker;

    internal AuthorityService(string configPath, string serviceName) { this.configPath = configPath; ServiceName = serviceName; AutoLog = false; CanStop = true; }

    protected override void OnStart(string[] args) {
      Thread thread = new Thread(Run) { IsBackground = true, Name = "AiopagoOperationAuthority" };
      thread.Start();
    }

    protected override void OnStop() {
      stopped.Set();
      try { if (worker != null && !worker.HasExited) worker.Kill(); } catch { }
    }

    private string ReadWorkerLine(string timeoutCode) {
      System.Threading.Tasks.Task<string> pending = worker.StandardOutput.ReadLineAsync();
      if (!pending.Wait(10000)) {
        try { worker.Kill(); } catch { }
        throw new System.TimeoutException(timeoutCode);
      }
      return pending.Result;
    }

    private void Fatal(string code, Exception error) {
      try {
        string runtime = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(configPath)), "runtime");
        Directory.CreateDirectory(runtime);
        Program.AtomicJson(Path.Combine(runtime, "failure.json"), new Dictionary<string, object> {
          { "schema", "aiopago.operation-authority-service-failure/1" }, { "code", code },
          { "message", error == null ? code : error.Message }, { "pid", Process.GetCurrentProcess().Id },
          { "timestamp", DateTime.UtcNow.ToString("o") }
        });
      } catch { }
      Environment.Exit(81);
    }

    private void Run() {
      try {
        Dictionary<string, object> config = Program.ReadObject(configPath);
        if (Program.Text(config, "schema") != "aiopago.operation-authority-service-config/1") throw new InvalidDataException("CONFIG_VERSION_MISMATCH");
        string serviceName = Program.Text(config, "serviceName");
        string serviceSid = Program.Text(config, "serviceSid");
        string root = Path.GetFullPath(Program.Text(config, "root"));
        string own = Process.GetCurrentProcess().MainModule.FileName;
        string node = Path.Combine(root, "bin", "node.exe");
        string workerPath = Path.Combine(root, "bin", "operation-authority-worker.mjs");
        string canonical = Path.Combine(root, "canonical");
        string runtime = Path.Combine(root, "runtime");
        string control = Path.Combine(root, "control");
        string keyPath = Path.Combine(canonical, "identity.bin");
        string databasePath = Path.Combine(canonical, "operations.sqlite");
        string initializedPath = Path.Combine(canonical, "initialized.v1");
        string scenarioPath = Path.Combine(control, "scenario.json");
        bool testScope = Program.Bool(config, "testScope");

        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        bool hasServiceSid = identity.Groups != null && identity.Groups.Cast<IdentityReference>().Any(group => group.Value == serviceSid);
        if (!hasServiceSid || identity.User == null || identity.User.Value != "S-1-5-19") throw new UnauthorizedAccessException("SERVICE_IDENTITY_MISMATCH");
        if (Program.Text(config, "protocol") != Program.Protocol) throw new InvalidDataException("PROTOCOL_VERSION_MISMATCH");
        if (Program.Sha256File(own) != Program.Text(config, "brokerSha256")
          || Program.Sha256File(node) != Program.Text(config, "nodeSha256")
          || Program.Sha256File(workerPath) != Program.Text(config, "workerSha256")) throw new InvalidDataException("PROTECTED_BINARY_IDENTITY_MISMATCH");

        bool keyExists = File.Exists(keyPath), databaseExists = File.Exists(databasePath), initialized = File.Exists(initializedPath);
        bool first = !keyExists && !databaseExists && !initialized;
        if (!first && (!keyExists || !databaseExists || !initialized)) throw new InvalidDataException("PROTECTED_STATE_INCOMPLETE");
        byte[] key;
        if (first) {
          key = new byte[32];
          using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(key);
          using (FileStream stream = new FileStream(keyPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
            stream.Write(key, 0, key.Length); stream.Flush(true);
          }
        } else key = File.ReadAllBytes(keyPath);
        if (key.Length != 32) throw new InvalidDataException("IDENTITY_KEY_INVALID");
        string fingerprint = Program.Sha256Bytes(key);

        Dictionary<string, object> scenario = Program.ReadObject(scenarioPath);
        if (Program.Text(scenario, "schema") != "aiopago.operation-authority-test-scenario/1" || !testScope) throw new InvalidDataException("SCENARIO_FORBIDDEN");
        object requestsValue;
        if (!scenario.TryGetValue("requests", out requestsValue) || !(requestsValue is object[])) throw new InvalidDataException("SCENARIO_REQUESTS_INVALID");
        object[] requests = (object[])requestsValue;
        if (requests.Length > 128) throw new InvalidDataException("SCENARIO_REQUEST_LIMIT");

        string capability;
        byte[] capabilityBytes = new byte[32];
        using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(capabilityBytes);
        capability = String.Concat(capabilityBytes.Select(b => b.ToString("x2")));

        ProcessStartInfo start = new ProcessStartInfo {
          FileName = node, Arguments = Program.Quote(workerPath), WorkingDirectory = root,
          UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.EnvironmentVariables.Remove("NODE_OPTIONS"); start.EnvironmentVariables.Remove("NODE_PATH"); start.EnvironmentVariables.Remove("PI_CODING_AGENT_ROOT");
        start.EnvironmentVariables["AIOPAGO_PROTECTED_OPERATION_WORKER"] = "1";
        worker = new Process { StartInfo = start, EnableRaisingEvents = true };
        if (!worker.Start()) throw new InvalidOperationException("P2_START_FAILED");

        Dictionary<string, object> hello = new Dictionary<string, object> {
          { "version", 1 }, { "protocol", Program.Protocol }, { "operationType", "SESSION_BIND" },
          { "capability", capability }, { "p1Pid", Process.GetCurrentProcess().Id }, { "p2Pid", worker.Id },
          { "serviceName", serviceName }, { "serviceSid", serviceSid }, { "identityFingerprint", fingerprint },
          { "systemDirectory", Environment.SystemDirectory }, { "canonicalPath", databasePath }, { "allowInitialize", first }, { "testScope", testScope }
        };
        worker.StandardInput.WriteLine(Program.Json.Serialize(hello)); worker.StandardInput.Flush();
        string readyLine = ReadWorkerLine("AUTHORITY_READY_TIMEOUT");
        if (readyLine == null) throw new InvalidOperationException("P2_READY_MISSING: " + worker.StandardError.ReadToEnd());
        Dictionary<string, object> ready = Program.Json.Deserialize<Dictionary<string, object>>(readyLine);
        if (Program.Text(ready, "operationType") != "SESSION_READY") throw new InvalidDataException("P2_READY_INVALID");

        ArrayList results = new ArrayList();
        bool crashRequested = false;
        foreach (object requestValue in requests) {
          Dictionary<string, object> request = requestValue as Dictionary<string, object>;
          if (request == null) throw new InvalidDataException("SCENARIO_FRAME_INVALID");
          request["version"] = 1; request["protocol"] = Program.Protocol; request["capability"] = capability;
          object operationType;
          crashRequested = request.TryGetValue("operationType", out operationType)
            && ((string)operationType == "TEST_CRASH_BEFORE_TERMINAL_COMMIT" || (string)operationType == "TEST_CRASH_BEFORE_LATCH_COMMIT");
          worker.StandardInput.WriteLine(Program.Json.Serialize(request)); worker.StandardInput.Flush();
          string line = ReadWorkerLine("AUTHORITY_REQUEST_TIMEOUT");
          if (line == null) {
            worker.WaitForExit(10000);
            if (crashRequested && (worker.ExitCode == 97 || worker.ExitCode == 98)) Environment.Exit(worker.ExitCode);
            throw new InvalidOperationException("P2_RESULT_MISSING: " + worker.StandardError.ReadToEnd());
          }
          results.Add(Program.Json.DeserializeObject(line));
        }
        worker.StandardInput.WriteLine(Program.Json.Serialize(new Dictionary<string, object> {
          { "version", 1 }, { "protocol", Program.Protocol }, { "operationType", "SESSION_END" }, { "capability", capability }
        })); worker.StandardInput.Flush();
        string completeLine = ReadWorkerLine("AUTHORITY_COMPLETE_TIMEOUT");
        if (completeLine == null) throw new InvalidOperationException("P2_COMPLETE_MISSING: " + worker.StandardError.ReadToEnd());
        worker.WaitForExit(10000);
        if (!worker.HasExited || worker.ExitCode != 0) throw new InvalidOperationException("P2_EXIT_INVALID");
        if (first) {
          using (FileStream stream = new FileStream(initializedPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
            byte[] marker = Encoding.ASCII.GetBytes("aiopago.operation-authority initialized v1\r\n");
            stream.Write(marker, 0, marker.Length); stream.Flush(true);
          }
        }
        Program.AtomicJson(Path.Combine(runtime, "latest-result.json"), new Dictionary<string, object> {
          { "schema", "aiopago.operation-authority-service-result/1" }, { "serviceName", serviceName },
          { "serviceSid", serviceSid }, { "p1Pid", Process.GetCurrentProcess().Id }, { "p2Pid", worker.Id },
          { "identityFingerprint", fingerprint }, { "firstInitialization", first }, { "results", results },
          { "complete", Program.Json.DeserializeObject(completeLine) }, { "timestamp", DateTime.UtcNow.ToString("o") }
        });
        stopped.WaitOne();
      } catch (Exception error) { Fatal(error.Message, error); }
    }
  }

  internal sealed class SentinelService : ServiceBase {
    private readonly string targetRoot, outputRoot;
    private readonly ManualResetEvent stopped = new ManualResetEvent(false);
    internal SentinelService(string serviceName, string targetRoot, string outputRoot) { this.targetRoot = targetRoot; this.outputRoot = outputRoot; ServiceName = serviceName; AutoLog = false; CanStop = true; }
    protected override void OnStart(string[] args) { new Thread(Run) { IsBackground = true }.Start(); }
    protected override void OnStop() { stopped.Set(); }
    private Dictionary<string, object> Attempt(string name, Action action) {
      try { action(); return new Dictionary<string, object> { { "operation", name }, { "denied", false }, { "error", null } }; }
      catch (Exception error) { return new Dictionary<string, object> { { "operation", name }, { "denied", error is UnauthorizedAccessException }, { "error", error.GetType().Name + ": " + error.Message } }; }
    }
    private void Run() {
      try {
        Directory.CreateDirectory(outputRoot);
        string database = Path.Combine(targetRoot, "canonical", "operations.sqlite");
        string key = Path.Combine(targetRoot, "canonical", "identity.bin");
        string broker = Path.Combine(targetRoot, "bin", "broker-service.exe");
        ArrayList attempts = new ArrayList {
          Attempt("canonical_read", delegate { File.ReadAllBytes(database); }),
          Attempt("latch_read", delegate { File.ReadAllBytes(database); }),
          Attempt("canonical_write", delegate { using (FileStream s = new FileStream(database, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { s.WriteByte(0); } }),
          Attempt("latch_write", delegate { using (FileStream s = new FileStream(database, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { s.WriteByte(0); } }),
          Attempt("latch_generation_mutation", delegate { using (FileStream s = new FileStream(database, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { s.Seek(128, SeekOrigin.Begin); s.WriteByte(0); } }),
          Attempt("key_access", delegate { File.ReadAllBytes(key); }),
          Attempt("canonical_acl_change", delegate {
            System.Security.AccessControl.FileSecurity security = File.GetAccessControl(database);
            security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(WindowsIdentity.GetCurrent().User, System.Security.AccessControl.FileSystemRights.FullControl, System.Security.AccessControl.AccessControlType.Allow));
            File.SetAccessControl(database, security);
          }),
          Attempt("broker_modification", delegate { using (FileStream s = new FileStream(broker, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { s.WriteByte(0); } })
        };
        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        Program.AtomicJson(Path.Combine(outputRoot, "sentinel-result.json"), new Dictionary<string, object> {
          { "schema", "aiopago.operation-authority-localservice-sentinel/1" }, { "userSid", identity.User.Value },
          { "groupSids", identity.Groups.Cast<IdentityReference>().Select(group => group.Value).ToArray() }, { "attempts", attempts }
        });
        stopped.WaitOne();
      } catch { Environment.Exit(82); }
    }
  }
}
