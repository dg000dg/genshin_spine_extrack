#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 Wayback 历史国际服官网采集崩坏：星穹铁道 Spine 资源。"""

from __future__ import annotations

import argparse
import gzip
import html
import json
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen


ROOT_URL = "https://hsr.hoyoverse.com/en-us/"
OUTPUT_DIR = Path("spine_data")
WAYBACK_CDX_URL = "https://web.archive.org/cdx"
WAYBACK_WEB_URL = "https://web.archive.org/web"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 SpineCollector/1.0"


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="Collect global Star Rail spine assets from Wayback snapshots.")
    parser.add_argument("--output", default=str(OUTPUT_DIR), help="输出目录，默认 spine_data")
    parser.add_argument("--max-versions", type=int, default=0, help="本次最多处理多少个未完成版本，0 表示不限制")
    parser.add_argument("--timeout", type=int, default=10, help="单个请求超时时间，单位秒")
    parser.add_argument("--sleep", type=float, default=1.5, help="Wayback 请求之间的等待秒数")
    parser.add_argument("--force", action="store_true", help="忽略 _done.json，重新处理版本")
    parser.add_argument("--dry-run", action="store_true", help="只扫描资源，不写入文件")
    return parser.parse_args()


def log(message: str) -> None:
    """输出带前缀的运行日志。"""
    print(f"[spine] {message}", flush=True)


def build_request(url: str) -> Request:
    """构造带浏览器标识的请求。"""
    return Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})


def fetch_bytes(url: str, timeout: int, retries: int = 3) -> bytes:
    """下载二进制内容，失败时进行有限重试。"""
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urlopen(build_request(url), timeout=timeout) as response:
                return response.read()
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            last_error = error
            if attempt < retries:
                time.sleep(1.2 + attempt)
    raise RuntimeError(f"下载失败: {url} ({last_error})")


def fetch_text(url: str, timeout: int, retries: int = 3) -> str:
    """按 UTF-8 下载并解码文本内容。"""
    data = fetch_bytes(url, timeout=timeout, retries=retries)
    if data.startswith(b"\x1f\x8b"):
        data = gzip.decompress(data)
    return data.decode("utf-8", errors="replace")


def fetch_wayback_snapshots(timeout: int) -> list[dict[str, str]]:
    """读取 Wayback 的官网快照索引。"""
    query = urlencode(
        {
            "url": ROOT_URL,
            "matchType": "exact",
            "output": "json",
            "filter": "statuscode:200",
            "fl": "timestamp,original,mimetype,statuscode,digest",
            "collapse": "digest",
            "to": "20269999999999",
        }
    )
    raw = fetch_text(f"{WAYBACK_CDX_URL}?{query}", timeout=timeout)
    rows = json.loads(raw)
    header, records = rows[0], rows[1:]
    snapshots = [dict(zip(header, row)) for row in records if row]
    snapshots = [item for item in snapshots if item.get("mimetype", "").startswith("text/html")]
    snapshots.sort(key=lambda item: item.get("timestamp", ""), reverse=True)
    return snapshots


def wayback_url(timestamp: str, original_url: str) -> str:
    """生成指定时间点的 Wayback 原始资源地址。"""
    return f"{WAYBACK_WEB_URL}/{timestamp}id_/{original_url}"


def normalize_escaped_url(value: str) -> str:
    """清理 JS 字符串里常见的转义 URL。"""
    value = html.unescape(value).strip().strip("\"'")
    value = value.replace("\\/", "/").replace("\\u002F", "/").replace("\\x2F", "/")
    return value


def strip_wayback_prefix(url: str) -> str:
    """去掉 Wayback 前缀，得到官网或 CDN 直链。"""
    match = re.match(r"^https?://web\.archive\.org/web/\d+(?:[a-z_]+)?/(https?:/{1,2}.+)$", url)
    if not match:
        return url

    direct_url = match.group(1)
    if direct_url.startswith("https:/") and not direct_url.startswith("https://"):
        direct_url = "https://" + direct_url[7:]
    if direct_url.startswith("http:/") and not direct_url.startswith("http://"):
        direct_url = "http://" + direct_url[6:]
    return direct_url


def resolve_direct_url(raw_url: str, base_url: str) -> str:
    """把相对路径或归档路径还原为可直接访问的资源 URL。"""
    raw_url = normalize_escaped_url(raw_url)
    if raw_url.startswith("//"):
        return "https:" + raw_url
    if raw_url.startswith("http://") or raw_url.startswith("https://"):
        return strip_wayback_prefix(raw_url)
    return urljoin(base_url, raw_url)


def clean_url_for_compare(url: str) -> str:
    """移除查询参数和片段，便于比较同名资源。"""
    parsed = urlparse(strip_wayback_prefix(url))
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", "")).lower()


def replace_url_ext(url: str, new_ext: str) -> str:
    """替换 URL 路径的文件扩展名。"""
    parsed = urlparse(url)
    path = re.sub(r"\.[^./?#]+$", new_ext, parsed.path)
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def extract_title(html_text: str) -> str:
    """从 HTML 中提取网页标题。"""
    match = re.search(r"<title[^>]*>(.*?)</title>", html_text, re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    return re.sub(r"\s+", " ", html.unescape(match.group(1))).strip()


def sanitize_name(value: str, fallback: str = "unknown") -> str:
    """清理文件夹或文件名中的非法字符。"""
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    value = re.sub(r"\s+", "_", value).strip("._ ")
    return (value or fallback)[:90]


def get_version_folder(html_text: str, timestamp: str) -> tuple[str, str, str]:
    """根据官网标题生成 x.x_title 版本文件夹名。"""
    title = extract_title(html_text)
    version_match = re.search(r"(\d+\.\d+)", title)
    title_match = re.search(r"版本[「“\"]([^」”\"]+)", title)
    if not title_match:
        title_match = re.search(r"Version\s+\d+\.\d+\s*[\"“]([^\"”]+)[\"”]", title, re.IGNORECASE)
    version = version_match.group(1) if version_match else "unknown"
    version_title = title_match.group(1) if title_match else title or timestamp
    folder = f"{version}_{sanitize_name(version_title, timestamp)}"
    return folder, version, version_title


def is_done(version_dir: Path) -> bool:
    """判断版本目录是否已经处理完成。"""
    return (version_dir / "_done.json").is_file()


def write_done(version_dir: Path, meta: dict[str, object]) -> None:
    """写入版本处理完成标记。"""
    version_dir.mkdir(parents=True, exist_ok=True)
    done_path = version_dir / "_done.json"
    done_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def clear_version_dir(output_dir: Path, version_dir: Path) -> None:
    """覆盖模式下清理当前版本目录。"""
    if not version_dir.exists():
        return
    root = output_dir.resolve()
    target = version_dir.resolve()
    if root != target and root not in target.parents:
        raise RuntimeError(f"拒绝清理输出目录外路径: {target}")
    for item in version_dir.iterdir():
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()


def extract_config_urls(html_text: str, timestamp: str) -> list[tuple[str, str]]:
    """从 HTML 中提取 config.*.js 的历史地址和直链地址。"""
    normalized = normalize_escaped_url(html_text)
    found: dict[str, tuple[str, str]] = {}
    pattern = re.compile(r"['\"]([^'\"]*config(?:[._-][^'\"]+?)?\.js(?:\?[^'\"]*)?)['\"]", re.IGNORECASE)
    for match in pattern.finditer(normalized):
        direct_url = resolve_direct_url(match.group(1), ROOT_URL)
        archive_url = wayback_url(timestamp, direct_url)
        found[direct_url] = (archive_url, direct_url)
    return list(found.values())


def extract_asset_urls(js_text: str, base_url: str) -> dict[str, list[str]]:
    """从 config JS 中提取 atlas/json/png 资源直链。"""
    normalized = normalize_escaped_url(js_text)
    pattern = re.compile(r"(?:(?:https?:)?//|\.{0,2}/|/)?[^\s'\"()<>]+?\.(atlas|json|png)(?:\?[^'\"\s()<>]*)?", re.IGNORECASE)
    assets: dict[str, dict[str, str]] = {"atlas": {}, "json": {}, "png": {}}
    for match in pattern.finditer(normalized):
        ext = match.group(1).lower()
        direct_url = resolve_direct_url(match.group(0), base_url)
        assets[ext][clean_url_for_compare(direct_url)] = direct_url
    return {ext: list(values.values()) for ext, values in assets.items()}


def extract_manifest_spines(js_text: str, base_url: str) -> list[dict[str, object]]:
    """从 config JS 的 manifest 字段提取 Spine 三件套配对。"""
    normalized = normalize_escaped_url(js_text)
    pattern = re.compile(r"manifest:\{atlas:\"([^\"]+)\",img:\[(.*?)\],json:\"([^\"]+)\"", re.IGNORECASE | re.DOTALL)
    groups = []
    for match in pattern.finditer(normalized):
        images = []
        for image_match in re.finditer(r"\{src:\"([^\"]+)\",id:\"([^\"]+)\"", match.group(2), re.IGNORECASE):
            images.append(
                {
                    "src": resolve_direct_url(image_match.group(1), base_url),
                    "id": image_match.group(2),
                }
            )
        groups.append(
            {
                "atlas": resolve_direct_url(match.group(1), base_url),
                "json": resolve_direct_url(match.group(3), base_url),
                "images": images,
            }
        )
    return groups


def merge_asset_maps(items: Iterable[dict[str, list[str]]]) -> dict[str, list[str]]:
    """合并多个 config JS 中提取到的资源。"""
    merged: dict[str, dict[str, str]] = {"atlas": {}, "json": {}, "png": {}}
    for item in items:
        for ext, urls in item.items():
            for url in urls:
                merged[ext][clean_url_for_compare(url)] = url
    return {ext: list(values.values()) for ext, values in merged.items()}


def find_partner_url(atlas_url: str, candidates: Iterable[str], ext: str) -> str:
    """按 atlas 同名规则查找对应 json 或 png URL。"""
    expected = clean_url_for_compare(replace_url_ext(atlas_url, ext))
    for candidate in candidates:
        if clean_url_for_compare(candidate) == expected:
            return candidate
    return replace_url_ext(atlas_url, ext)


def parse_atlas_png_url(atlas_text: str, atlas_url: str) -> str:
    """从 atlas 内容第一张贴图行解析 png URL。"""
    png_names = parse_atlas_png_names(atlas_text)
    if png_names:
        return urljoin(atlas_url, quote(png_names[0], safe="/:%#?=&"))
    return replace_url_ext(atlas_url, ".png")


def parse_atlas_png_names(atlas_text: str) -> list[str]:
    """从 atlas 内容解析全部贴图页文件名。"""
    png_names = []
    for line in atlas_text.splitlines():
        value = line.strip()
        if not value or ":" in value:
            continue
        if value.lower().endswith(".png"):
            png_names.append(value)
    return png_names


def parse_atlas_png_name(atlas_text: str) -> str:
    """从 atlas 内容第一张贴图行解析 png 文件名。"""
    png_names = parse_atlas_png_names(atlas_text)
    return png_names[0] if png_names else ""


def find_manifest_png_url(atlas_text: str, manifest: dict[str, object] | None) -> str:
    """根据 atlas 贴图名从 manifest 图片列表中查找真实 png 地址。"""
    if not manifest:
        return ""
    png_name = parse_atlas_png_name(atlas_text)
    image_id = Path(png_name).stem
    for image in manifest.get("images", []):
        if isinstance(image, dict) and image.get("id") == image_id:
            return str(image.get("src") or "")
    return ""


def find_manifest_png_items(atlas_text: str, atlas_url: str, manifest: dict[str, object] | None) -> list[dict[str, str]]:
    """根据 atlas 全部贴图页名从 manifest 图片列表中查找真实 png 地址。"""
    items = []
    for png_name in parse_atlas_png_names(atlas_text):
        image_id = Path(png_name).stem
        png_url = ""
        if manifest:
            for image in manifest.get("images", []):
                if isinstance(image, dict) and image.get("id") == image_id:
                    png_url = str(image.get("src") or "")
                    break
        if not png_url:
            png_url = urljoin(atlas_url, quote(png_name, safe="/:%#?=&"))
        items.append(
            {
                "name": safe_relative_name(png_name, source_file_name(png_url, "asset.png")),
                "url": png_url,
            }
        )
    return items


def is_spine_json(data: bytes) -> bool:
    """判断 JSON 内容是否像 Spine 骨骼数据。"""
    try:
        obj = json.loads(data.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        return False
    return isinstance(obj, dict) and ("skeleton" in obj or "bones" in obj or "animations" in obj)


def is_png(data: bytes) -> bool:
    """判断二进制内容是否为 PNG 图片。"""
    return data.startswith(b"\x89PNG\r\n\x1a\n")


def source_file_name(url: str, fallback: str) -> str:
    """从资源 URL 中提取原始文件名。"""
    path = urlparse(url).path
    name = Path(path).name
    return sanitize_name(name, fallback)


def safe_relative_name(value: str, fallback: str) -> str:
    """清理并保留 atlas 中的相对贴图路径。"""
    parts = [sanitize_name(part, "") for part in value.replace("\\", "/").split("/")]
    parts = [part for part in parts if part and part not in {".", ".."}]
    return "/".join(parts) or fallback


def pick_output_dir(version_dir: Path, group: dict[str, object], used: set[str]) -> Path:
    """为资源组选择不会覆盖已有文件的输出目录。"""
    base_name = sanitize_name(Path(str(group["atlas_name"])).stem, "asset")
    candidate = base_name
    index = 2
    while candidate in used or (version_dir / candidate).exists():
        candidate = f"{base_name}_{index}"
        index += 1
    used.add(candidate)
    return version_dir / candidate


def save_asset_group(output_dir: Path, group: dict[str, object]) -> None:
    """按原始文件名保存 Spine 三件套到版本目录。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / str(group["atlas_name"])).write_bytes(group["atlas"])
    (output_dir / str(group["json_name"])).write_bytes(group["json"])
    for png_item in group.get("pngs", []):
        if not isinstance(png_item, dict):
            continue
        png_path = output_dir / str(png_item["name"])
        png_path.parent.mkdir(parents=True, exist_ok=True)
        png_path.write_bytes(png_item["data"])


def collect_asset_group(
    atlas_url: str,
    assets: dict[str, list[str]],
    timeout: int,
    manifest: dict[str, object] | None = None,
) -> dict[str, object] | None:
    """按 atlas 反查并下载对应 png/json 三件套。"""
    try:
        atlas_data = fetch_bytes(atlas_url, timeout=timeout)
        atlas_text = atlas_data.decode("utf-8", errors="replace")
        png_name = parse_atlas_png_name(atlas_text) or source_file_name(replace_url_ext(atlas_url, ".png"), "asset.png")
        png_url = find_manifest_png_url(atlas_text, manifest) or parse_atlas_png_url(atlas_text, atlas_url)
        json_url = str(manifest.get("json")) if manifest and manifest.get("json") else find_partner_url(atlas_url, assets.get("json", []), ".json")
        json_data = fetch_bytes(json_url, timeout=timeout)
        png_items = find_manifest_png_items(atlas_text, atlas_url, manifest)
        if not png_items:
            png_items = [{"name": safe_relative_name(png_name, source_file_name(png_url, "asset.png")), "url": png_url}]
        for png_item in png_items:
            png_item["data"] = fetch_bytes(str(png_item["url"]), timeout=timeout)
    except RuntimeError as error:
        log(f"跳过不完整资源: {atlas_url} | {error}")
        return None

    if not is_spine_json(json_data):
        log(f"跳过非 Spine JSON: {json_url}")
        return None
    for png_item in png_items:
        if not is_png(png_item["data"]):
            log(f"跳过非 PNG 图片: {png_item['url']}")
            return None

    return {
        "atlas_url": atlas_url,
        "json_url": json_url,
        "png_url": png_url,
        "atlas_name": source_file_name(atlas_url, "asset.atlas"),
        "json_name": source_file_name(json_url, "asset.json"),
        "png_name": safe_relative_name(png_name, source_file_name(png_url, "asset.png")),
        "atlas": atlas_data,
        "json": json_data,
        "png": png_items[0]["data"],
        "pngs": png_items,
    }


def process_snapshot(snapshot: dict[str, str], args: argparse.Namespace, output_dir: Path, seen_versions: set[str]) -> bool:
    """处理单个官网历史快照并保存资源。"""
    timestamp = snapshot["timestamp"]
    html_url = wayback_url(timestamp, ROOT_URL)
    log(f"读取历史 HTML: {timestamp}")
    html_text = fetch_text(html_url, timeout=args.timeout)
    version_folder, version, version_title = get_version_folder(html_text, timestamp)
    version_dir = output_dir / version_folder
    config_urls = extract_config_urls(html_text, timestamp)

    if version == "unknown" or not config_urls:
        log(f"快照缺少版本标题或 config，跳过: {timestamp}")
        return False
    if version_folder in seen_versions:
        log(f"本轮已处理同名版本，跳过快照: {version_folder} | {timestamp}")
        return False

    if is_done(version_dir) and not args.force:
        log(f"已完成，跳过版本: {version_folder}")
        seen_versions.add(version_folder)
        return False
    if args.force and not args.dry_run:
        log(f"覆盖已生成版本: {version_folder}")
        clear_version_dir(output_dir, version_dir)

    log(f"版本 {version_folder} 找到 config JS: {len(config_urls)}")
    asset_maps = []
    manifest_groups = []
    for archive_url, direct_url in config_urls:
        log(f"config 历史链接: {archive_url}")
        log(f"config 直链: {direct_url}")
        time.sleep(args.sleep)
        try:
            js_text = fetch_text(archive_url, timeout=args.timeout)
        except RuntimeError as error:
            log(f"读取 config 失败: {direct_url} | {error}")
            continue
        asset_maps.append(extract_asset_urls(js_text, direct_url))
        manifest_groups.extend(extract_manifest_spines(js_text, direct_url))

    assets = merge_asset_maps(asset_maps)
    manifest_by_atlas = {clean_url_for_compare(str(item["atlas"])): item for item in manifest_groups}
    atlas_urls = list(manifest_by_atlas.keys())
    atlas_urls.extend(clean_url_for_compare(url) for url in assets.get("atlas", []) if clean_url_for_compare(url) not in manifest_by_atlas)
    log(f"版本 {version_folder} 找到 atlas: {len(atlas_urls)}")
    if not atlas_urls:
        log(f"版本未找到 atlas，不写入完成标记: {version_folder}")
        return False

    saved = []
    used_names: set[str] = set()
    direct_atlas_urls = {clean_url_for_compare(url): url for url in assets.get("atlas", [])}
    for atlas_key in atlas_urls:
        manifest = manifest_by_atlas.get(atlas_key)
        atlas_url = str(manifest["atlas"]) if manifest else direct_atlas_urls.get(atlas_key, atlas_key)
        log(f"atlas 直链: {atlas_url}")
        group = collect_asset_group(atlas_url, assets, timeout=args.timeout, manifest=manifest)
        if not group:
            continue
        output_path = pick_output_dir(version_dir, group, used_names)
        if not args.dry_run:
            save_asset_group(output_path, group)
        saved.append(
            {
                "path": str(output_path.relative_to(version_dir)).replace("\\", "/"),
                "atlas_name": group["atlas_name"],
                "json_name": group["json_name"],
                "png_name": group["png_name"],
                "atlas": group["atlas_url"],
                "json": group["json_url"],
                "png": group["png_url"],
                "pngs": [
                    {"name": str(item["name"]), "url": str(item["url"])}
                    for item in group.get("pngs", [])
                    if isinstance(item, dict)
                ],
            }
        )
        rel_path = output_path.relative_to(version_dir)
        rel_text = "" if str(rel_path) == "." else str(rel_path).replace("\\", "/") + "/"
        log(f"保存资源: {version_folder}/{rel_text}{group['atlas_name']}")

    if not saved:
        log(f"版本没有保存到完整三件套，不写入完成标记: {version_folder}")
        return False

    if not args.dry_run:
        write_done(
            version_dir,
            {
                "timestamp": timestamp,
                "version": version,
                "title": version_title,
                "source": html_url,
                "config_count": len(config_urls),
                "atlas_count": len(atlas_urls),
                "saved_count": len(saved),
                "assets": saved,
            },
        )
    seen_versions.add(version_folder)
    log(f"版本完成: {version_folder}，保存 {len(saved)} 组")
    return True


def main() -> int:
    """执行从新到旧的版本采集流程。"""
    args = parse_args()
    output_dir = Path(args.output)
    snapshots = fetch_wayback_snapshots(timeout=args.timeout)
    log(f"官网根地址: {ROOT_URL}")
    log(f"Wayback 快照数量: {len(snapshots)}")

    processed = 0
    seen_versions: set[str] = set()
    for snapshot in snapshots:
        try:
            changed = process_snapshot(snapshot, args, output_dir, seen_versions)
        except Exception as error:
            log(f"快照处理失败: {snapshot.get('timestamp')} | {error}")
            continue

        if changed:
            processed += 1
        if args.max_versions > 0 and processed >= args.max_versions:
            break
        time.sleep(args.sleep)

    log(f"本次处理新版本数量: {processed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
