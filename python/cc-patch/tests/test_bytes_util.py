from cc_patch.features import bytes_util


def test_simple():
    text = "a{b}c"
    assert bytes_util.find_matching_brace(text, 1) == 3


def test_nested():
    text = "{a{b}c}"
    assert bytes_util.find_matching_brace(text, 0) == 6


def test_ignores_brace_in_string():
    text = '{a="}";b}'
    assert bytes_util.find_matching_brace(text, 0) == len(text) - 1


def test_ignores_brace_in_template():
    text = "{x=`}`;y}"
    assert bytes_util.find_matching_brace(text, 0) == len(text) - 1


def test_ignores_brace_in_line_comment():
    text = "{// }\n}"
    assert bytes_util.find_matching_brace(text, 0) == len(text) - 1


def test_unbalanced_returns_none():
    assert bytes_util.find_matching_brace("{a", 0) is None


def test_non_brace_start_returns_none():
    assert bytes_util.find_matching_brace("ab", 0) is None


def test_ignores_brace_in_block_comment():
    text = "{a/* } */b}"
    assert bytes_util.find_matching_brace(text, 0) == len(text) - 1


def test_ignores_escaped_quote_in_string():
    text = '{a="\\"}";b}'
    assert bytes_util.find_matching_brace(text, 0) == len(text) - 1


def test_ignores_escaped_backtick_in_template():
    text = "{x=`\\`}`;y}"
    assert bytes_util.find_matching_brace(text, 0) == len(text) - 1


def test_find_all_returns_overlapping_offsets():
    assert bytes_util.find_all(b"aaaa", b"aa") == [0, 1, 2]


def test_find_all_returns_empty_when_pattern_absent():
    assert bytes_util.find_all(b"abc", b"z") == []
