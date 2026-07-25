import subprocess

import pytest

from cc_patch import atomicio, orchestrate


DECISION_JS = (
    'function x7$(H,$,q){'
    'if(!$?.experimental?.["claude/channel"])'
    'return{action:"skip",kind:"capability",reason:"server did not declare claude/channel capability"};'
    'if(n6()!=="firstParty")'
    'return{action:"skip",kind:"provider",reason:"channels are not available on third-party providers"};'
    'if(!oYH())'
    'return{action:"skip",kind:"disabled",reason:"channels feature is not currently available"};'
    'let _=TGH(H);'
    'if(!_)return{action:"skip",kind:"session",reason:`not in list`};'
    'else if(!_.dev)'
    'return{action:"skip",kind:"allowlist",reason:`server ${_.name} is not on the approved channels allowlist`};'
    'return{action:"register"}}'
)


@pytest.fixture(autouse=True)
def isolated_shared_store(monkeypatch, tmp_path):
    monkeypatch.setenv("UNBUN_CC_STORE", str(tmp_path / "shared-store"))
    monkeypatch.setattr(orchestrate, "STORE", None)
    monkeypatch.setattr(atomicio, "BACKUP_DIR", tmp_path / "legacy-backups")


def make_bundle() -> bytearray:
    text = (
        "// @bun @bytecode @bun-cjs\n"
        'function oYH(){return w$("tengu_harbor",!1)}'
        'function hV4(){return w$("tengu_harbor_permissions",!1)}'
        'X={URL:"https://code.claude.com/docs/en/overview",VERSION:"2.1.175"};'
        'if(i6["claude/channel"]&&(!oYH()||!b$q(u8.config.pluginSource)))delete i6["claude/channel"];'
        # 刻意用与真实二进制不同的 minified 变量名 `Q`（真实实测为 S/E/A 轮换），
        # 以在合成层面锁死「锚点不依赖变量名」这一回归防线。
        'agentTool={model:Q.enum(["sonnet","opus","haiku","fable"])'
        '.optional().describe(`Optional model override for this agent. any string ok`)};'
        + DECISION_JS
    )
    return bytearray(text.encode("latin-1"))


@pytest.fixture(name="make_bundle")
def make_bundle_fixture():
    return make_bundle


@pytest.fixture
def fake_codesign():
    calls: list[list[str]] = []
    responder = {"fn": lambda args: subprocess.CompletedProcess(args, 0, "", "")}

    def runner(args):
        calls.append(list(args))
        return responder["fn"](args)

    return type(
        "FakeCodesign",
        (),
        {
            "calls": calls,
            "runner": staticmethod(runner),
            "set": lambda self, fn: responder.__setitem__("fn", fn),
        },
    )()
