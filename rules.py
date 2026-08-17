# -*- coding: utf-8 -*-
"""rules.py — 規則層的共用判定（能力分類／地理鄰近／名稱正規化）。

原本這些函式住在 suppliers.py，與 104 爬取、AI 評語、存檔、推播混在同一個檔。
104 資料源移除後把它們抽出來獨立成模組，理由有二：

  1. **它們是規則層的核心，必須每次都跑**——第三層備援可信的前提是
     這些程式碼從不休息。混在已停用的爬取模組裡，遲早跟著一起腐爛。
  2. 供應商與客戶兩個雷達共用同一份判定，抽出來才看得出「共用」是事實。

這裡的每一個函式都是**確定性**的：同樣輸入永遠同樣輸出。
變化偵測依賴這個性質——若判定會浮動，「少了 50 家」就分不出是真的
消失還是判定改變了。**AI 不得覆寫本模組產出的任何欄位。**
"""
import re

import config

# 台灣縣市（政府檔用「臺」、民間網站多用「台」，兩種都列）
CITIES = [
    "台北市", "臺北市", "新北市", "桃園市", "台中市", "臺中市", "台南市", "臺南市",
    "高雄市", "基隆市", "新竹市", "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣",
    "嘉義市", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "台東縣", "臺東縣",
    "澎湖縣", "金門縣", "連江縣",
]

_LEGAL_SUFFIX = re.compile(r"(股份有限公司|有限公司|企業社|工業社|實業|企業|工廠|公司)$")


def categorize(blob: str) -> str:
    """把描述文字歸到 config.SUPPLIER_CATEGORIES 的能力類別。

    依序比對，先命中者勝——故詞庫的排列順序本身就是優先序，
    調整順序即可改變歸類傾向，毋須動程式。
    """
    b = blob.lower()
    for name, kws in config.SUPPLIER_CATEGORIES:
        if any(k.lower() in b for k in kws):
            return name
    return "其他金屬加工"


def is_relevant(blob: str) -> bool:
    """是否與金屬加工相關（粗篩用）。"""
    return any(k in blob for k in config.SUPPLIER_RELEVANCE)


def near_rank(location: str) -> int:
    """地理鄰近級數：本地=4、相鄰近區=3、同市其他=2、其他縣市=1。

    這是**行政區分級，不是實際距離**。要算真距離需把地址轉經緯度，
    而免費的地理編碼服務有速率限制、付費的違反零成本前提。
    論文須誠實說明此為粗略近似。
    """
    if config.SUPPLIER_NEAR["home"] in location:
        return 4
    if any(d in location for d in config.SUPPLIER_NEAR["adjacent"]):
        return 3
    if "台中" in location or "臺中" in location:
        return 2
    return 1


def norm_name(name: str) -> str:
    """公司名正規化（去法人字尾與空白）。

    註：改用統一編號對帳後，本函式已非必要——同一公司各廠共用統編，
    廠別後綴（一廠／二廠／台中廠）的問題自動消失。保留供未來若引入
    無統編的資料源時使用。
    """
    n = re.sub(r"\s+", "", name or "")
    return _LEGAL_SUFFIX.sub("", n)
