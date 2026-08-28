// Real medium-integrity P0 attack oracle. Launched through the existing Explorer token.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const configPath = process.argv[2];
if (!configPath) throw new Error("CONFIG_REQUIRED");
const config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
const outputPath = config.outputPath;
const matrix = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sys = (name) => join(process.env.SystemRoot, "System32", name);
const command = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true });
  return { exitCode: result.status, stdout: result.stdout?.trim() || "", stderr: result.stderr?.trim() || "", error: result.error?.message ?? null };
};
const attempt = (attack, operation) => {
  try { const value = operation(); matrix.push({ attack, allowed: true, actual: value ?? "SUCCEEDED" }); return true; }
  catch (error) { matrix.push({ attack, allowed: false, actual: { code: error.code ?? null, errno: error.errno ?? null, syscall: error.syscall ?? null, message: error.message } }); return false; }
};
const commandAttempt = (attack, file, args) => {
  const actual = command(file, args); matrix.push({ attack, allowed: actual.exitCode === 0, actual }); return actual.exitCode === 0;
};

const whoamiUser = command(sys("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
const whoamiGroups = command(sys("whoami.exe"), ["/groups", "/fo", "csv", "/nh"]);
const sid = whoamiUser.stdout.match(/S-1-[0-9-]+/)?.[0] ?? null;
const integritySid = whoamiGroups.stdout.match(/S-1-16-(?:4096|8192|8448|12288|16384)/)?.[0] ?? null;
const identity = { pid: process.pid, parentPid: process.ppid, whoamiUser, integritySid, mediumIntegrity: integritySid === "S-1-16-8192", administratorGroupDenyOnly: /S-1-5-32-544[^\r\n]*(?:deny|negat|solo)/i.test(whoamiGroups.stdout), groups: whoamiGroups.stdout };

if (config.mode === "projection-replay") {
  const old = readFileSync(config.oldProjectionPath);
  attempt("replay exact older signed public projection", () => { writeFileSync(config.projectionPath, old); return { sha256: digest(old), bytes: old.length }; });
  writeFileSync(outputPath, `${JSON.stringify({ schema:"aiopago.r1-m-13-p0-attack/1", mode:config.mode, identity, matrix }, null, 2)}\n`);
  process.exit(0);
}
if (config.mode === "acl-only") {
  const trustee=`*${sid}`;
  commandAttempt("protected parent ACL change",sys("icacls.exe"),[dirname(config.rootPath),"/grant:r",`${trustee}:(R)`]);
  commandAttempt("protected root ACL change",sys("icacls.exe"),[config.rootPath,"/grant:r",`${trustee}:(R)`]);
  commandAttempt("private key ACL change",sys("icacls.exe"),[config.keyPath,"/grant:r",`${trustee}:(R)`]);
  commandAttempt("canonical ACL change",sys("icacls.exe"),[config.canonicalPath,"/grant:r",`${trustee}:(OI)(CI)(R)`]);
  commandAttempt("protected binary ACL change",sys("icacls.exe"),[config.binaryPath,"/grant:r",`${trustee}:(R)`]);
  writeFileSync(outputPath, `${JSON.stringify({ schema:"aiopago.r1-m-13-p0-attack/1", mode:config.mode, identity, matrix }, null, 2)}\n`);
  process.exit(0);
}
if (config.mode === "access-only") {
  attempt("protected binary read",()=>{const data=readFileSync(config.binaryPath);return {bytes:data.length,sha256:digest(data)};});
  attempt("protected root enumerate",()=>readdirSync(config.rootPath));
  attempt("canonical directory enumerate",()=>readdirSync(config.canonicalPath));
  attempt("canonical directory delete",()=>rmSync(config.canonicalPath,{recursive:true}));
  attempt("protected root delete",()=>rmSync(config.rootPath,{recursive:true}));
  writeFileSync(outputPath, `${JSON.stringify({ schema:"aiopago.r1-m-13-p0-attack/1", mode:config.mode, identity, matrix }, null, 2)}\n`);
  process.exit(0);
}

const attackerRoot = config.attackerRoot;
mkdirSync(attackerRoot, { recursive: true });
const replacement = join(attackerRoot, "replacement.bin");
writeFileSync(replacement, Buffer.from("P0-REPLACEMENT"));

let keyBytes = null;
attempt("private key open/read", () => { keyBytes = readFileSync(config.keyPath); return { bytes:keyBytes.length, sha256:digest(keyBytes) }; });
attempt("private key copy", () => { const destination=join(attackerRoot,"copied-key.bin");copyFileSync(config.keyPath,destination);return destination; });
attempt("private key cryptographic use", () => {
  const raw = keyBytes ?? readFileSync(config.keyPath);
  if (raw.length !== 64) throw Object.assign(new Error("RAW_ED25519_KEY_LENGTH_INVALID"),{code:"KEY_FORMAT"});
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),raw.subarray(0,32)]);
  const signature=sign(null,Buffer.from("OP-FORGED-BY-P0"),createPrivateKey({key:pkcs8,format:"der",type:"pkcs8"}));
  return { signatureBytes:signature.length };
});
attempt("private key delete", () => unlinkSync(config.keyPath));
attempt("private key replace", () => copyFileSync(replacement,config.keyPath));
attempt("private key rename-over", () => renameSync(replacement,config.keyPath));
commandAttempt("private key ACL change",sys("icacls.exe"),[config.keyPath,"/grant:r",`${sid}:(R)`]);

attempt("canonical state open/read", () => { const data=readFileSync(config.statePath);return {bytes:data.length,sha256:digest(data)}; });
attempt("canonical state write", () => writeFileSync(config.statePath,Buffer.from("P0-FORGED-CANONICAL")));
attempt("canonical state delete", () => unlinkSync(config.statePath));
attempt("canonical state replace", () => copyFileSync(replacement,config.statePath));
const renameSource=join(attackerRoot,"rename-source.json");writeFileSync(renameSource,"P0-RENAME-OVER");
attempt("canonical rename-over", () => renameSync(renameSource,config.statePath));
commandAttempt("canonical ACL change",sys("icacls.exe"),[config.canonicalPath,"/grant:r",`${sid}:(OI)(CI)(R)`]);

attempt("protected broker overwrite bytes", () => writeFileSync(config.binaryPath,Buffer.from("P0-BINARY")));
attempt("protected broker rename away", () => renameSync(config.binaryPath,`${config.binaryPath}.p0-away`));
attempt("protected broker replacement", () => copyFileSync(replacement,config.binaryPath));
attempt("protected bin containing-directory modification", () => mkdirSync(join(dirname(config.binaryPath),"p0-child")));
commandAttempt("protected binary ACL change",sys("icacls.exe"),[config.binaryPath,"/grant:r",`${sid}:(R)`]);
attempt("protected root similarly named child", () => mkdirSync(join(dirname(config.rootPath),"R1M13Poc-p0-similar")));

for (const [kind,target] of [["canonical",config.canonicalPath],["binary",dirname(config.binaryPath)]]) {
  const link=join(attackerRoot,`${kind}-junction`);rmSync(link,{recursive:true,force:true});
  attempt(`${kind} junction creation in attacker directory`, () => { symlinkSync(target,link,"junction"); return {reparse:lstatSync(link).isSymbolicLink()}; });
  attempt(`${kind} access through attacker junction`, () => { const path=kind==="canonical"?join(link,"state.json"):join(link,config.binaryName);writeFileSync(path,"P0-REPARSE-WRITE"); });
  const substitute=join(attackerRoot,`${kind}-substitute`);rmSync(substitute,{recursive:true,force:true});
  const substituteCreated=attempt(`${kind} attacker reparse substitute creation`, () => {symlinkSync(attackerRoot,substitute,"junction");return {reparse:lstatSync(substitute).isSymbolicLink()};});
  if(substituteCreated) attempt(`${kind} reparse rename-over protected directory`, () => renameSync(substitute,target));
}

const sc=sys("sc.exe");
commandAttempt("service binary-path configuration mutation",sc,["config",config.serviceName,"binPath=",`\"${config.binaryPath}\" --windows-service`]);
commandAttempt("service account configuration mutation",sc,["config",config.serviceName,"obj=","NT AUTHORITY\\LocalService"]);
commandAttempt("service SID-type mutation",sc,["sidtype",config.serviceName,"restricted"]);
commandAttempt("service DACL mutation",sc,["sdset",config.serviceName,config.serviceSddl]);
commandAttempt("service delete",sc,["delete",config.serviceName]);
commandAttempt("public SCM query",sc,["query",config.serviceName]);

const originalProjection=readFileSync(config.projectionPath);
writeFileSync(config.oldProjectionPath,originalProjection);
attempt("older public projection replay", () => { const old={schema:"aiopago.r1-m-13-public-projection/1",fingerprint:config.fingerprint,sequence:0,records:[],canonicalInput:false};writeFileSync(config.projectionPath,`${JSON.stringify(old)}\n`);return {sequence:0}; });
attempt("fake higher-sequence projection", () => { const forged={schema:"aiopago.r1-m-13-public-projection/1",fingerprint:"P0-FORGED",sequence:999,records:[{requestId:"OP-FORGED-BY-P0"}],canonicalInput:false};const bytes=Buffer.from(`${JSON.stringify(forged)}\n`);writeFileSync(config.projectionPath,bytes);return {sequence:999,sha256:digest(bytes)}; });
attempt("public projection delete/replace", () => { unlinkSync(config.projectionPath);writeFileSync(config.projectionPath,JSON.stringify({sequence:1000,forgedBy:"P0"}));return "SUCCEEDED_AS_EXPECTED_FOR_DERIVED_DATA"; });
attempt("public confused-deputy semantic request fabrication", () => { const path=join(dirname(config.projectionPath),"OP-FORGED-BY-P0.json");writeFileSync(path,JSON.stringify({operation:"POC_OPERATION_TERMINAL",requestId:"OP-FORGED-BY-P0"}));return path; });
commandAttempt("confused-deputy attempt through public SCM start",sc,["start",config.serviceName]);

writeFileSync(outputPath, `${JSON.stringify({ schema:"aiopago.r1-m-13-p0-attack/1", mode:config.mode, identity, matrix }, null, 2)}\n`);
