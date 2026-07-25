def find_all(data: bytes, pattern: bytes) -> list[int]:
    """返回 data 中 pattern 的所有起始偏移。"""
    results: list[int] = []
    start = 0
    while (idx := data.find(pattern, start)) != -1:
        results.append(idx)
        start = idx + 1
    return results


def find_matching_brace(text: str, open_idx: int) -> int | None:
    """从 open_idx 处的 ``{`` 出发做花括号配对，跳过字符串 / 模板串 / 注释。

    返回匹配 ``}`` 的索引；找不到返回 None。
    """
    if open_idx < 0 or open_idx >= len(text) or text[open_idx] != "{":
        return None

    depth = 0
    mode = "normal"
    i = open_idx
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""

        if mode == "normal":
            if ch == "/" and nxt == "/":
                mode = "line_comment"
                i += 2
                continue
            if ch == "/" and nxt == "*":
                mode = "block_comment"
                i += 2
                continue
            if ch == "'":
                mode = "single"
            elif ch == '"':
                mode = "double"
            elif ch == "`":
                mode = "template"
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return i
        elif mode == "single":
            if ch == "\\":
                i += 2
                continue
            if ch == "'":
                mode = "normal"
        elif mode == "double":
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                mode = "normal"
        elif mode == "template":
            if ch == "\\":
                i += 2
                continue
            if ch == "`":
                mode = "normal"
        elif mode == "line_comment":
            if ch == "\n":
                mode = "normal"
        elif mode == "block_comment":
            if ch == "*" and nxt == "/":
                mode = "normal"
                i += 2
                continue

        i += 1
    return None
