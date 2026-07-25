# ARCHIVED — PoC/实验 provenance，勿运行。见 tools/unbun/
import os, pty, select, time, sys, subprocess, tempfile, shutil
cfg = tempfile.mkdtemp()
env = dict(os.environ, CLAUDE_CONFIG_DIR=cfg, TERM="xterm-256color")
args = ["bun", "run.cjs"] + sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bun", args, env)
buf = b""; t0 = time.time()
while time.time() - t0 < 6:
    r,_,_ = select.select([fd], [], [], 0.5)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        buf += d
        if len(buf) > 200000: break
# send Ctrl-C then 'q' to try to exit cleanly
try: os.write(fd, b"\x03"); time.sleep(0.2); os.write(fd, b"q")
except OSError: pass
time.sleep(0.3)
try: os.kill(pid, 9)
except: pass
shutil.rmtree(cfg, ignore_errors=True)
out = buf.decode("utf-8","replace")
# strip most ANSI for readability
import re
clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", out)
clean = re.sub(r"\x1b[\(\)][AB0]", "", clean).replace("\x1b","")
print("=== captured %d bytes; cleaned render: ===" % len(buf))
print(clean[:2500])
