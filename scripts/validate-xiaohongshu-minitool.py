"""使用标准 HTMLParser 检查小工具入口、资源与 DOM，扫描实际业务脚本的禁用能力。"""
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


class EntryParser(HTMLParser):
    """只读取 HTML 结构和属性，避免自行实现 HTML 解析规则。"""
    def __init__(self):
        super().__init__()
        self.ids = []
        self.resources = []
        self.scripts = []
        self.errors = []
        self.in_script = False
        self.has_charset = False
        self.viewport = ""
        self.language = ""
        self.doctype = False

    def handle_decl(self, declaration):
        self.doctype = declaration.lower() == "doctype html"

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag in {"iframe", "object", "base"}:
            self.errors.append(f"禁用标签：{tag}")
        for key, value in attributes:
            if key.startswith("on"):
                self.errors.append(f"内联事件：{key}")
            if value and value.lower().startswith("javascript:"):
                self.errors.append("javascript URI")
        if tag == "html":
            self.language = attrs.get("lang", "")
        if tag == "meta":
            self.has_charset |= attrs.get("charset", "").lower() == "utf-8"
            if attrs.get("name") == "viewport":
                self.viewport = attrs.get("content", "")
            if attrs.get("http-equiv", "").lower() == "content-security-policy":
                self.errors.append("自行声明 CSP")
        if tag == "script":
            self.in_script = True
            if attrs.get("type") == "module" or not attrs.get("src"):
                self.errors.append("脚本必须使用包内经典外链脚本")
            self.scripts.append(attrs.get("src", ""))
        if tag == "a" and ("download" in attrs or attrs.get("target") == "_blank"):
            self.errors.append("禁用下载或外链跳转")
        if tag == "form" and attrs.get("action"):
            self.errors.append("表单跳转提交")
        for key in ("src", "href"):
            if attrs.get(key):
                self.resources.append(attrs[key])

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_script = False

    def handle_data(self, data):
        if self.in_script and data.strip():
            self.errors.append("内联脚本")


def main():
    """只检查真实产物；不创建模拟 SDK 或模拟判题环境。"""
    root = Path(sys.argv[1]).resolve()
    expected = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    parser = EntryParser()
    parser.feed((root / "index.html").read_text(encoding="utf-8"))
    errors = parser.errors
    if not parser.doctype or not parser.has_charset or parser.language != "zh-CN":
        errors.append("入口文档声明不完整")
    if any(value not in parser.viewport for value in ("width=device-width", "initial-scale=1.0", "viewport-fit=cover")):
        errors.append("viewport 声明不完整")
    if len(parser.ids) != len(set(parser.ids)) or set(expected) != set(parser.ids):
        errors.append("HTML 与业务脚本的 DOM 元素清单不一致")
    if parser.scripts != ["./assets/data.js", "./assets/main.js"]:
        errors.append("脚本加载顺序不正确")
    for resource in parser.resources:
        target = (root / resource).resolve()
        if not resource.startswith("./") or root not in target.parents or not target.is_file():
            errors.append(f"资源不可用：{resource}")
    if set(str(file.relative_to(root)).replace("\\", "/") for file in root.rglob("*") if file.is_file()) != {"index.html", "assets/style.css", "assets/data.js", "assets/main.js"}:
        errors.append("产物包含非预期文件")
    main_source = (root / "assets/main.js").read_text(encoding="utf-8")
    forbidden = [r"\bfetch\s*\(", r"\bXMLHttpRequest\b", r"\bWebSocket\b", r"\bEventSource\b", r"\bRTCPeerConnection\b", r"\b(?:Shared)?Worker\s*\(", r"\beval\s*\(", r"\bnew\s+Function\b", r"\bWebAssembly\b", r"navigator\.(?:clipboard|geolocation|bluetooth|usb|hid|serial|serviceWorker|credentials|locks|connection|storage)", r"document\.execCommand", r"window\.(?:open|prompt)\s*\(", r"location\.(?:href|assign|replace)", r"\b(?:import|export)\s", r"\.requestFullscreen\s*\("]
    for pattern in forbidden:
        if re.search(pattern, main_source):
            errors.append(f"业务脚本命中禁用能力：{pattern}")
    css = (root / "assets/style.css").read_text(encoding="utf-8")
    for pattern in [r"(?:^|[;{\s])(?:gap|row-gap|column-gap|inset|aspect-ratio)\s*:", r"\b(?:clamp|min|max|color-mix)\s*\(", r":has\(", r"@(?:container|layer|property)\b", r"\b\d+(?:dvh|svh|lvh)\b", r"url\(\s*['\"]?https?://"]:
        if re.search(pattern, css):
            errors.append(f"CSS 命中未提供基线的能力：{pattern}")
    if errors:
        raise SystemExit("\n".join(errors))
    print(f"PASS: HTML 结构、{len(expected)} 个 DOM 元素、资源顺序与路径、禁用能力及 CSS 基线扫描")


if __name__ == "__main__":
    main()
