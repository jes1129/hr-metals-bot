#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
資訊安全關卡 — 推送前掃描（九上科技 ERP，公開 repo）
============================================================
在每次 git push 前執行（由 .githooks/pre-push 呼叫），掃描「追蹤中的文字檔」是否
夾帶機密或個資。兩級發現都會擋下 push（exit 1）：

  🔴 機密      金鑰/私鑰/token/憑證檔/身分證字號 —— 一定擋
  🟡 疑似個資  台灣手機/email/門牌地址 —— 也擋，但標明讓你先覆核

逃生門：確認某筆是「公開資料/誤報」時，加 --allow-warn 只放行「🟡 疑似個資」那一批
（🔴 機密永遠不放行）。config.js 的公開設定值、日期、OAuth id 等已列入允許清單。

用法：
  python scripts/security_scan.py              # 完整掃描；有發現→exit 1
  python scripts/security_scan.py --allow-warn # 放行🟡疑似個資（🔴仍擋）
  python scripts/security_scan.py --staged     # 只掃已 staged 的檔案
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 不掃描（二進位/文件/公開商業名單）
SKIP_EXT = {".docx", ".doc", ".xlsx", ".pdf", ".png", ".jpg", ".jpeg", ".gif",
            ".ico", ".webp", ".zip", ".woff", ".woff2", ".ttf", ".mp3", ".mp4"}
# data/*.json 是公開商業名單（無電話），對「疑似個資」豁免（機密仍照掃）
PII_EXEMPT_PREFIX = ("data/",)

# ── 允許清單：本來就公開可見、非機密（避免每次誤擋）──────────────────
ALLOW_SUBSTRINGS = (
    "509401161611-606pnfvcp974le4q0mbdjnjb3g6sq7m4.apps.googleusercontent.com",
    "script.google.com/macros/s/",
    "docs.google.com/spreadsheets/",
    "notebooklm.google.com/notebook/",
    "Session.getActiveUser().getEmail()",  # 程式碼，非字面 email
    "getNotifyEmails_",                    # 函式名
    "NOTIFY_EMAILS",                       # 屬性名（值不在 repo）
    "GROQ_API_KEY",                        # 只是屬性「名稱」；真值放 Script Property，不在 repo
)
ALLOW_REGEX = (
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),                       # 日期 YYYY-MM-DD
    re.compile(r"\bv=\d{6,}\b"),                                # 資產版本號 ?v=時間戳
    re.compile(r"\d{6,}-[\w-]+\.apps\.googleusercontent\.com"),  # OAuth client id
)

# ── 🔴 機密規則（一定擋）──────────────────────────────────────────
SECRET_RULES = [
    ("Groq API key",     re.compile(r"\bgsk_[A-Za-z0-9]{20,}")),
    ("Google API key",   re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}")),
    ("OpenAI API key",   re.compile(r"\bsk-[A-Za-z0-9]{20,}")),
    ("Slack token",      re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}")),
    ("AWS access key",   re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token",     re.compile(r"\bghp_[A-Za-z0-9]{30,}")),
    ("私鑰 PRIVATE KEY", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("台灣身分證字號",   re.compile(r"\b[A-Z][12]\d{8}\b")),
]
# 硬編機密賦值另外處理（要看「值」像不像真金鑰，避免占位符/環境變數名誤報）
SECRET_ASSIGN_RE = re.compile(
    r"(?i)(api[_-]?key|secret|password|passwd|token|access[_-]?key)\s*[:=]\s*['\"]([^'\"]{8,})['\"]")


def looks_like_placeholder(val):
    """值像環境變數名/占位符（非真金鑰）→ 不算機密。"""
    if re.fullmatch(r"[A-Z][A-Z0-9_]{2,}", val):        # 全大寫底線＝環境變數名，如 LOGIN_104_PASSWORD
        return True
    low = val.strip().lower()
    if low in ("", "your_key_here", "changeme", "xxx", "todo", "none", "null",
               "your_api_key", "replace_me", "example"):
        return True
    if not re.search(r"[a-z]", val) and not re.search(r"\d.*[A-Za-z]|[A-Za-z].*\d", val):
        return True  # 沒有小寫、也不像混合亂碼 → 多半是名稱/常數
    return False
# 憑證/環境檔本身就不該進版控
SECRET_FILENAMES = re.compile(
    r"(^|/)(\.env(\.\w+)?|credentials\.json|service_account.*\.json|client_secret.*\.json)$|\.pem$|\.p12$|\.pfx$"
)

# ── 🟡 疑似個資規則（也擋，但可 --allow-warn 放行）────────────────
# 註：不掃「門牌地址」——「號/樓」太易誤判(每月1號/20樓)，且客戶/供應商為公開商業登記地址、
#     地圖功能需要用；真正敏感的是手機/email/身分證(身分證在🔴機密)。
PII_RULES = [
    ("台灣手機",   re.compile(r"\b09\d{8}\b")),
    ("Email",      re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.(?:com|org|net|edu|gov|tw)\b")),
]
# 範本/占位符 email（非真個資）→ 不報
PLACEHOLDER_EMAIL = re.compile(
    r"(?i)(your[-_.]?email|example|changeme|test|user|foo|bar|placeholder|sample|admin|noreply|no-reply)@|@example\.(?:com|org|net)")


def tracked_files(staged_only=False):
    try:
        if staged_only:
            out = subprocess.check_output(
                ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
                cwd=ROOT, text=True, encoding="utf-8", errors="ignore")
        else:
            out = subprocess.check_output(
                ["git", "ls-files"], cwd=ROOT, text=True, encoding="utf-8", errors="ignore")
    except Exception as e:
        print(f"⚠️ 無法列出檔案（不是 git repo？）：{e}")
        return []
    files = [f.strip() for f in out.splitlines() if f.strip()]
    return files


def is_allowed(line):
    if any(s in line for s in ALLOW_SUBSTRINGS):
        return True
    return False


def strip_allowed(line):
    """把允許清單命中的片段挖掉，避免它們觸發別的規則（如日期/OAuth id 觸發身分證/手機）。"""
    for rx in ALLOW_REGEX:
        line = rx.sub(" ", line)
    for s in ALLOW_SUBSTRINGS:
        line = line.replace(s, " ")
    return line


def snippet(line, m):
    a = max(0, m.start() - 12)
    b = min(len(line), m.end() + 12)
    s = line[a:b].strip()
    return (s[:60] + "…") if len(s) > 60 else s


def scan():
    staged = "--staged" in sys.argv
    files = tracked_files(staged_only=staged)
    secrets, piis = [], []

    for rel in files:
        ext = os.path.splitext(rel)[1].lower()
        # 檔名層級：憑證/環境檔進版控＝機密
        if SECRET_FILENAMES.search(rel):
            secrets.append((rel, 0, "憑證/環境檔進版控", rel))
        if ext in SKIP_EXT:
            continue
        path = os.path.join(ROOT, rel.replace("/", os.sep))
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                lines = fh.readlines()
        except Exception:
            continue
        pii_exempt = rel.startswith(PII_EXEMPT_PREFIX)
        for i, raw in enumerate(lines, 1):
            if is_allowed(raw):
                clean = strip_allowed(raw)
            else:
                clean = strip_allowed(raw)
            # 🔴 機密
            for name, rx in SECRET_RULES:
                for m in rx.finditer(clean):
                    secrets.append((rel, i, name, snippet(clean, m)))
            # 🔴 硬編機密賦值（值要像真金鑰才算）
            for m in SECRET_ASSIGN_RE.finditer(clean):
                if not looks_like_placeholder(m.group(2)):
                    secrets.append((rel, i, "硬編機密賦值", snippet(clean, m)))
            # 🟡 疑似個資（data/ 商業名單豁免）
            if not pii_exempt:
                for name, rx in PII_RULES:
                    for m in rx.finditer(clean):
                        if name == "Email" and PLACEHOLDER_EMAIL.search(m.group(0)):
                            continue
                        piis.append((rel, i, name, snippet(clean, m)))

    return secrets, piis


def main():
    allow_warn = "--allow-warn" in sys.argv
    secrets, piis = scan()

    print("=" * 60)
    print("🔒 資訊安全關卡 — 推送前掃描")
    print("=" * 60)

    if secrets:
        print(f"\n🔴 機密（{len(secrets)} 筆）— 一定擋，請移除後再推：")
        for rel, ln, name, sn in secrets:
            print(f"   {rel}:{ln}  [{name}]  {sn}")
    if piis:
        print(f"\n🟡 疑似個資（{len(piis)} 筆）— 也會擋；確認是公開資料/誤報可用 --allow-warn 放行：")
        for rel, ln, name, sn in piis:
            print(f"   {rel}:{ln}  [{name}]  {sn}")

    # 判定
    if secrets:
        print("\n❌ 發現機密，已擋下 push。請把金鑰/個資移出 repo（改存私有試算表或 Script Property）。")
        return 1
    if piis and not allow_warn:
        print("\n❌ 發現疑似個資，已擋下 push。覆核後若確定可公開，再加 --allow-warn 重推。")
        return 1
    if piis and allow_warn:
        print("\n⚠️ 已用 --allow-warn 放行上列疑似個資（🔴 機密不受影響）。")

    print("\n✅ 資安檢查通過，可以安全推送。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
