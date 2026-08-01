"""
YouTube Tools - Ferramentas para IA buscar e extrair conteúdo do YouTube
Baseado em yt-dlp - Otimizado para agentes LLM
"""
import subprocess
import json
import sys
import os
import re
import time
import random

# Configuração base
YTDLP_MODULE = [sys.executable, "-m", "yt_dlp"]


def run_yt(args, timeout=120, cwd=None):
    """Executa yt-dlp com argumentos e retorna output"""
    # Adicionar flags para suprimir warnings e output verboso
    # Configurar deno como JS runtime se estiver instalado
    quiet_args = ["--quiet", "--no-warnings", "--no-progress", "--js-runtimes", "deno"]
    cmd = YTDLP_MODULE + quiet_args + args
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            cwd=cwd
        )
        # yt-dlp outputs binary; decode with replacement for invalid chars
        raw_out = result.stdout if result.stdout is not None else b""
        raw_err = result.stderr if result.stderr is not None else b""
        stdout = raw_out.decode("utf-8", errors="replace") if isinstance(raw_out, bytes) else str(raw_out)
        stderr = raw_err.decode("utf-8", errors="replace") if isinstance(raw_err, bytes) else str(raw_err)
        return stdout, stderr, result.returncode
    except subprocess.TimeoutExpired:
        return "", "TIMEOUT", 1
    except Exception as e:
        return "", str(e), 1


def format_duration(secs):
    """Converte segundos para HH:MM:SS"""
    if not secs or secs == "NA":
        return "00:00:00"
    try:
        s = int(float(secs))
        return f"{s//3600:02d}:{(s%3600)//60:02d}:{s%60:02d}"
    except:
        return "00:00:00"


def format_timestamp(secs):
    """Converte segundos para [HH:MM:SS] com décimos"""
    if secs is None:
        return "00:00:00"
    try:
        s = float(secs)
        h = int(s // 3600)
        m = int((s % 3600) // 60)
        sec = s % 60
        return f"{h:02d}:{m:02d}:{sec:05.2f}"
    except:
        return "00:00:00"


def build_timestamp_url(video_url, seconds, buffer_seconds=15):
    """
    Constrói URL do YouTube com timestamp de início.
    Usa ?t= para links curtos (youtu.be) e &t= para links longos.
    Formatos aceitos: integer (segundos), ou string '1m30s', '1h2m3s'.

    Se buffer_seconds > 0, subtrai esse valor do timestamp para iniciar
    o vídeo N segundos antes do ponto solicitado, dando tempo de contexto.
    O timestamp mínimo é 0 (não inicia em tempo negativo).
    """
    if not seconds:
        return video_url

    # Converter para integer se possível
    try:
        total_secs = int(float(seconds))
    except (ValueError, TypeError):
        total_secs = seconds  # pode ser string tipo "1m30s"

    # Aplicar buffer de contexto: iniciar X segundos antes
    if isinstance(total_secs, int) and total_secs > buffer_seconds:
        total_secs -= buffer_seconds
    elif isinstance(total_secs, float) and total_secs > buffer_seconds:
        total_secs = int(total_secs - buffer_seconds)

    # Determinar formato ?t= ou &t=
    if "?" in video_url and "watch?" in video_url:
        separator = "&t="
    else:
        separator = "?t="

    # Se for integer, formatar como '90s' ou deixar como número
    if isinstance(total_secs, int):
        ts_param = f"{total_secs}s"
    else:
        ts_param = str(total_secs)

    return f"{video_url}{separator}{ts_param}"


def open_video_at(video_url, timestamp, browser="chrome", buffer_seconds=15):
    """
    Abre vídeo no Chrome a partir do timestamp especificado.

    Args:
        video_url: URL do vídeo do YouTube
        timestamp: segundos (int/float) ou string '1m30s', '1h2m3s'
        browser: navegador a usar (default: chrome)
        buffer_seconds: segundos antes do timestamp solicitado para dar contexto (default: 15)
    """
    import subprocess
    url = build_timestamp_url(video_url, timestamp, buffer_seconds=buffer_seconds)
    chrome_path = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    if os.path.exists(chrome_path):
        subprocess.Popen([chrome_path, url])
    else:
        import webbrowser
        webbrowser.open(url)
    return url


def parse_video_line(line):
    """Parseia uma linha do flat-playlist do yt-dlp"""
    if not line or "|" not in line:
        return None

    parts = [p.strip() for p in line.split("|")]
    if len(parts) < 6:
        return None

    video = {
        "id": parts[0] if parts[0] else "",
        "title": parts[1] if parts[1] else "",
        "url": parts[5] if parts[5] else "",
    }
    # Só adicionar campos se não forem "NA" ou vazios
    if parts[2] and parts[2] != "NA":
        video["upload_date"] = parts[2]
    dur = format_duration(parts[3]) if parts[3] else "00:00:00"
    if dur != "00:00:00":
        video["duration"] = dur
    if parts[4] and parts[4] != "NA":
        video["view_count"] = parts[4]
    return video


# ══════════════════════════════════════════════════════════════════════════════
# FUNÇÕES PRINCIPAIS
# ══════════════════════════════════════════════════════════════════════════════

def _ensure_full_url(url):
    """Garante que a URL seja completa com https://www.youtube.com/"""
    url = url.strip()
    # Channel ID (começa com UC)
    if url.startswith("UC") and len(url) > 20:
        return f"https://www.youtube.com/channel/{url}"
    if url.startswith("@"):
        return f"https://www.youtube.com/{url.lstrip('@')}"
    if url.startswith("/"):
        return f"https://www.youtube.com{url}"
    if not url.startswith("http"):
        return f"https://www.youtube.com/{url.lstrip('@')}"
    return url


def list_channel_videos(channel_url, filter_type="videos", max_results=None, lang=None, use_enrich=False):
    """
    Lista vídeos de um canal com metadados rich.

    Args:
        channel_url: URL do canal (@nome, /channel/ID, /user/nome, ou URL completa)
        filter_type: 'videos', 'shorts', 'streams', 'playlists'
        max_results: limite (None = todos)
        lang: filtro de idioma ( None = pt-BR, 'all' = todos)
        use_enrich: se True, faz dump-json em cada vídeo (lento mas completo com upload_date/view_count)

    Returns:
        Lista de dicts com: id, title, description, upload_date, duration, view_count, url
    """
    # Garantir URL completa
    base = _ensure_full_url(channel_url).rstrip("/")

    # Mapear tipo para URL
    suffix_map = {
        "videos": "/videos",
        "shorts": "/shorts",
        "streams": "/streams",
        "playlists": "/playlists",
    }
    url = base + suffix_map.get(filter_type, "/videos")

    if use_enrich:
        # Modo rápido: buscar só IDs via flat-playlist
        args = ["--flat-playlist", "--print", "%(id)s"]
        if max_results:
            args.extend(["--playlist-end", str(max_results)])
        if lang:
            args.extend(["--match-filter", f"language = {lang}"])
        args.append(url)

        stdout, stderr, code = run_yt(args, timeout=120)

        video_ids = []
        if code == 0 and stdout:
            for line in stdout.strip().split("\n"):
                line = line.strip()
                if line and not line.startswith("["):
                    video_ids.append(line)

        # Enrich cada ID com dump-json
        videos = []
        for vid in video_ids:
            info = get_video_info(vid)
            if "error" not in info and info.get("id"):
                videos.append(info)
        return videos

    # Modo rápido (padrão): flat-playlist com format string
    # NOTA: upload_date e view_count vem como "NA" na maioria dos canais
    args = [
        "--flat-playlist",
        "--print", "%(id)s|%(title)s|%(upload_date)s|%(duration)s|%(view_count)s|%(url)s",
    ]

    if max_results:
        args.extend(["--playlist-end", str(max_results)])

    if lang:
        args.extend(["--match-filter", f"language = {lang}"])

    args.append(url)

    stdout, stderr, code = run_yt(args)

    videos = []
    if code == 0 and stdout:
        for line in stdout.strip().split("\n"):
            video = parse_video_line(line)
            if video:
                videos.append(video)

    return videos


def get_video_info(video_url_or_id):
    """
    Obtém informações detalhadas de UM vídeo específico.

    Args:
        video_url_or_id: URL completa (youtube.com/watch?v=ID) ou só o ID

    Returns:
        Dict com: id, title, description, upload_date, duration, view_count,
                 like_count, channel, channel_id, tags, url, thumbnail
    """
    # Se passou só ID, montar URL
    if not video_url_or_id.startswith("http"):
        video_url_or_id = f"https://www.youtube.com/watch?v={video_url_or_id}"

    args = ["--dump-json", video_url_or_id]
    stdout, stderr, code = run_yt(args)

    if code == 0 and stdout:
        try:
            data = json.loads(stdout.strip())

            # Limpar description (pode ser longa)
            description = data.get("description", "") or ""
            if len(description) > 2000:
                description = description[:2000] + "..."

            info = {
                "id": data.get("id", ""),
                "title": data.get("title", ""),
                "description": description,
                "url": data.get("webpage_url", data.get("url", "")),
            }
            # Só adicionar campos com valores válidos (não NA, não 0 quando relevante)
            if data.get("upload_date") and data.get("upload_date") != "NA":
                info["upload_date"] = data.get("upload_date")
            dur = format_duration(data.get("duration", 0)) if data.get("duration") else None
            if dur and dur != "00:00:00":
                info["duration"] = dur
            if data.get("view_count"):
                info["view_count"] = data.get("view_count")
            if data.get("like_count"):
                info["like_count"] = data.get("like_count")
            if data.get("channel"):
                info["channel"] = data.get("channel")
            if data.get("channel_id"):
                info["channel_id"] = data.get("channel_id")
            if data.get("subtitles") and data.get("subtitles"):
                info["subtitles"] = list(data.get("subtitles", {}).keys())
            return info
        except json.JSONDecodeError:
            return {"error": "JSON parse error", "raw": stdout[:500]}

    return {"error": stderr or "Video not found", "url": video_url_or_id}


def search_channel(query):
    """
    Busca informação de um canal pelo @username ou nome.
    Retorna: channel_id, name, subscribers, url

    Args:
        query: @username (ex: @MINDTHEHEADPHONE) ou URL completa

    Returns:
        Dict com metadados do canal
    """
    # Garantir URL completa
    url = _ensure_full_url(query)
    if not url.endswith("/videos") and not "/shorts" in url and not "/playlists" in url:
        url = url + "/videos"

    # Primeiro pegar um vídeo do canal
    args = [
        "--flat-playlist",
        "--playlist-end", "1",
        "--print", "%(id)s|%(url)s",
        url
    ]

    stdout, stderr, code = run_yt(args, timeout=30)

    video_url = None
    if code == 0 and stdout and "|" in stdout:
        parts = stdout.strip().split("|")
        if len(parts) >= 2:
            video_url = parts[1].strip() if parts[1].strip().startswith("http") else f"https://www.youtube.com/watch?v={parts[0].strip()}"

    if not video_url:
        video_url = url.rstrip("/") + "/videos"

    # Buscar info do vídeo para obter channel info
    video_info = get_video_info(video_url)
    if "error" not in video_info:
        result = {}
        if video_info.get("channel_id"):
            result["channel_id"] = video_info["channel_id"]
        if video_info.get("channel"):
            result["name"] = video_info["channel"]
        if video_info.get("url"):
            result["url"] = video_info["url"]
        if result:
            return result

    return {"error": f"Canal nao encontrado: {query}"}


def get_channel_info(channel_url):
    """
    Obtém informações completas de um canal incluindo número de inscritos.
    Usa deno como JS runtime para extrair subscriber count.

    Args:
        channel_url: URL do canal (@username ou URL completa)

    Returns:
        Dict com: channel_id, name, subscribers, video_count, url
    """
    # Garantir URL completa
    url = _ensure_full_url(channel_url)

    # Primeiro: pegar um vídeo do canal via flat-playlist (rápido)
    channel_url_videos = url.rstrip("/") + "/videos"
    args1 = [
        "--flat-playlist",
        "--playlist-end", "1",
        "--print", "%(id)s|%(url)s",
        channel_url_videos
    ]

    stdout1, stderr1, code1 = run_yt(args1, timeout=15)

    video_url = None
    if code1 == 0 and stdout1 and "|" in stdout1:
        parts = [p.strip() for p in stdout1.strip().split("|")]
        if len(parts) >= 2:
            video_url = parts[1] if parts[1].startswith("http") else f"https://www.youtube.com/watch?v={parts[0]}"

    # Segundo: com o vídeo, buscar dump-json completo (com deno)
    if video_url:
        args2 = ["--dump-json", video_url]
        stdout2, stderr2, code2 = run_yt(args2, timeout=25)

        if code2 == 0 and stdout2:
            try:
                data = json.loads(stdout2.strip())
                result = {}
                if data.get("channel_id"):
                    result["channel_id"] = data["channel_id"]
                if data.get("channel"):
                    result["name"] = data["channel"]
                if data.get("channel_follower_count"):
                    result["subscribers"] = data["channel_follower_count"]
                if data.get("webpage_url"):
                    result["url"] = data["webpage_url"]
                if result:
                    return result
            except json.JSONDecodeError:
                pass

    # Fallback: buscar info básica
    return search_channel(channel_url)

def get_channel_id_from_video(video_url):
    """
    Descobre o channel ID a partir de uma URL de vídeo.
    Útil quando não sabe o canal mas tem um vídeo.
    """
    info = get_video_info(video_url)
    if "channel_id" in info:
        return info["channel_id"]
    return info.get("channel", "NA")


def search_channels(query, max_results=10):
    """
    Busca canais do YouTube por nome/keyword usando ytsearch.
    Primeiro busca IDs via flat-playlist, depois enrich com get_channel_info() em cada um.

    Args:
        query: termo de busca (ex: "headphone review", "fone teste")
        max_results: número máximo de resultados (default 10)

    Returns:
        Lista de dicts com: channel_id, name, subscribers, video_count, url
    """
    # Primeiro: buscar channel IDs rapidamente via flat-playlist
    args = [
        "--flat-playlist",
        "--playlist-end", str(max_results),
        "--print", "%(channel_id)s",
        f"ytsearch{max_results}:{query} channel"
    ]

    stdout, stderr, code = run_yt(args, timeout=60)

    channel_ids = []
    if code == 0 and stdout:
        for line in stdout.strip().split("\n"):
            line = line.strip()
            if line and not line.startswith("[") and line != "NA":
                channel_ids.append(line)

    # Segundo: enrich cada canal com get_channel_info
    results = []
    for cid in channel_ids:
        info = get_channel_info(cid)
        if "error" not in info and info.get("channel_id"):
            results.append(info)

    return results


def search_videos(query, max_results=10):
    """
    Busca vídeos do YouTube por nome/keyword usando ytsearch.
    Primeiro busca IDs via flat-playlist, depois enrich com dump-json em cada um.

    Args:
        query: termo de busca (ex: "best headphone 2025", "review fone")
        max_results: número máximo de resultados (default 10)

    Returns:
        Lista de dicts com: id, title, description, upload_date, view_count,
                            duration, channel, channel_id, url, thumbnail
    """
    # Primeiro: buscar IDs rapidamente via flat-playlist
    args = [
        "--flat-playlist",
        "--playlist-end", str(max_results),
        "--print", "%(id)s",
        f"ytsearch{max_results}:{query}"
    ]

    stdout, stderr, code = run_yt(args, timeout=60)

    video_ids = []
    if code == 0 and stdout:
        for line in stdout.strip().split("\n"):
            line = line.strip()
            if line and not line.startswith("["):
                video_ids.append(line)

    # Segundo: enrich cada ID com dump-json
    results = []
    for vid in video_ids:
        info = get_video_info(vid)
        if "error" not in info and info.get("id"):
            results.append(info)

    return results


def extract_transcript(video_url, language="pt-BR", output_dir=None, return_content=False, include_timestamp=False):
    """
    Extrai transcrição/legenda de UM vídeo usando youtube-transcript-api.

    Args:
        video_url: URL do vídeo
        language: código do idioma (pt-BR, en, pt, etc)
        output_dir: diretório para salvar arquivo (None = não salva)
        return_content: se True, retorna texto; se False, retorna dict
        include_timestamp: se True, inclui timestamp [HH:MM:SS] antes de cada trecho
    """
    # Extrair video_id da URL
    video_id = video_url
    if "watch?v=" in video_url:
        video_id = video_url.split("watch?v=")[-1].split("&")[0]
    elif not video_id.startswith("UC"):
        video_id = video_id.strip()

    # Mapear pt-BR → pt (youtube-transcript-api usa código ISO simples)
    lang_map = {"pt-BR": "pt", "en": "en", "es": "es", "all": ["en", "pt", "es"]}
    lang_codes = lang_map.get(language, language)
    if isinstance(lang_codes, str):
        lang_codes = [lang_codes]

    # Tentar com retry
    last_error = None
    for attempt in range(5):
        try:
            from youtube_transcript_api import YouTubeTranscriptApi
            transcript = YouTubeTranscriptApi().fetch(video_id, languages=lang_codes)
            lines = [(x.text, x.start) for x in transcript]

            # Converter para texto puro
            text_parts = []
            for text, start in lines:
                # Limpar encoding ruins
                clean = text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")
                if include_timestamp:
                    # Formatar timestamp como [HH:MM:SS]
                    ts = format_timestamp(start)
                    text_parts.append(f"[{ts}] {clean}")
                else:
                    text_parts.append(clean)

            plain_text = " ".join(text_parts)

            # Salvar em arquivo se output_dir
            filename = None
            if output_dir:
                os.makedirs(output_dir, exist_ok=True)
                # Gerar nome de arquivo
                safe_name = f"{video_id}_transcript_{language}.txt"
                filepath = os.path.join(output_dir, safe_name)
                with open(filepath, "w", encoding="utf-8", errors="replace") as f:
                    f.write(plain_text)
                filename = filepath

            if return_content:
                return plain_text

            return {
                "code": 0,
                "text": plain_text,
                "filename": filename,
                "language": language,
            }

        except Exception as e:
            last_error = str(e)
            if attempt < 4:
                delay = 5 * (2 ** attempt) + random.uniform(0, 2)
                time.sleep(delay)

    # Falhou após retries
    if return_content:
        return f"Error: {last_error}"

    return {
        "code": 1,
        "error": last_error,
        "filename": None,
        "stdout": "",
        "stderr": f"Error after 5 retries: {last_error}",
    }


def batch_extract_transcripts(channel_url, language="pt-BR", output_dir="yt_transcripts", max_videos=None):
    """
    Extrai transcrições de TODOS os vídeos de um canal.

    Args:
        channel_url: URL do canal
        language: código do idioma
        output_dir: diretório de saída
        max_videos: limite de vídeos (None = todos)

    Returns:
        Dict com estatísticas e arquivos gerados
    """
    os.makedirs(output_dir, exist_ok=True)

    args = [
        "--skip-download",
        "--write-auto-subs",
        "--write-subs",
        "--sub-lang", language,
        "--convert-subs", "txt",
        "--download-archive", os.path.join(output_dir, "archive.txt"),
        "-o", f"{output_dir}/%(upload_date>%Y-%m-%d)s_%(title)s",
        f"{channel_url}/videos"
    ]

    if max_videos:
        args.extend(["--playlist-end", str(max_videos)])

    stdout, stderr, code = run_yt(args, timeout=600)

    # Listar arquivos gerados
    generated = []
    if os.path.exists(output_dir):
        for f in os.listdir(output_dir):
            if f.endswith(".txt"):
                generated.append(f)

    return {
        "success": code == 0,
        "output_dir": output_dir,
        "files_generated": len(generated),
        "files": generated[:50],  # Limitado para não estourar output
        "stdout_preview": stdout[-2000:] if stdout else "",
    }


def filter_videos_by_duration(videos, min_sec=None, max_sec=None):
    """Filtra lista de vídeos por duração"""
    result = []
    for v in videos:
        dur = v.get("duration_raw", "0")
        try:
            secs = int(float(dur))
            if min_sec and secs < min_sec:
                continue
            if max_sec and secs > max_sec:
                continue
            result.append(v)
        except:
            result.append(v)  # Include if can't parse
    return result


def filter_videos_by_title(videos, keyword):
    """Filtra vídeos cujo título ou descrição contenha palavra/chave (case-insensitive)"""
    keyword = keyword.lower()
    result = []
    for v in videos:
        title = v.get("title", "") or ""
        desc = v.get("description", "") or ""
        if keyword in title.lower() or keyword in desc.lower():
            result.append(v)
    return result


def _save_json(data, filename=None):
    """Salva JSON no diretório atual de execução"""
    import os
    cwd = os.getcwd()
    if filename is None:
        # Gerar nome baseado no canal/tipo
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"yt_output_{timestamp}.json"
    filepath = os.path.join(cwd, filename)
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return filepath


# ══════════════════════════════════════════════════════════════════════════════
# CLI INTERFACE
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import io
    from datetime import datetime

    # Ensure stdout can handle any unicode character without crashing on Windows
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    except Exception:
        pass  # Already handled or not needed

    import argparse

    parser = argparse.ArgumentParser(
        description="YouTube Tools - Ferramentas para IAs",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # list-channel
    p = sub.add_parser("list-channel", help="Lista vídeos de um canal")
    p.add_argument("channel", help="@nome ou URL do canal")
    p.add_argument("-f", "--filter", choices=["videos", "shorts", "streams", "playlists"], default="videos")
    p.add_argument("-m", "--max", type=int, help="Máximo de resultados")
    p.add_argument("--lang", help="Filtrar por idioma")
    p.add_argument("--keyword", "-k", help="Filtrar vídeos whose title contains keyword (case-insensitive)")
    p.add_argument("--save", "-s", metavar="FILENAME", help="Salvar resultado em JSON no diretório atual")
    p.add_argument("--duration-min", type=int, help="Duração mínima em segundos")
    p.add_argument("--duration-max", type=int, help="Duração máxima em segundos")

    # video-info
    p = sub.add_parser("video-info", help="Info detalhada de um vídeo")
    p.add_argument("url", help="URL ou ID do vídeo")
    p.add_argument("--save", "-s", metavar="FILENAME", help="Salvar resultado em JSON")

    # search-channel
    p = sub.add_parser("search-channel", help="Busca canal por @username (rápido)")
    p.add_argument("query", help="@nome do canal")
    p.add_argument("--save", "-s", metavar="FILENAME", help="Salvar resultado em JSON")

    # channel-info
    p = sub.add_parser("channel-info", help="Info completa de canal incluindo subscribers")
    p.add_argument("channel", help="@nome ou URL do canal")
    p.add_argument("--save", "-s", metavar="FILENAME", help="Salvar resultado em JSON")

    # transcript
    p = sub.add_parser("transcript", help="Extrai transcrição de vídeo")
    p.add_argument("url", help="URL do vídeo")
    p.add_argument("-l", "--lang", default="pt-BR")
    p.add_argument("-o", "--output-dir")
    p.add_argument("--return-content", action="store_true", help="Retorna conteúdo em vez de path")
    p.add_argument("--save", "-s", metavar="FILENAME", help="Salvar resultado em JSON")
    p.add_argument("--timestamp", action="store_true", help="Inclui timestamp [HH:MM:SS] antes de cada trecho")

    # batch-transcript
    p = sub.add_parser("batch-transcript", help="Extrai transcrições em massa")
    p.add_argument("channel", help="URL do canal")
    p.add_argument("-l", "--lang", default="pt-BR")
    p.add_argument("-o", "--output-dir", default="yt_transcripts")
    p.add_argument("-m", "--max", type=int, help="Máximo de vídeos")
    p.add_argument("--save", "-s", metavar="FILENAME", help="Salvar resultado em JSON")

    # filter (stdin based)
    p = sub.add_parser("filter", help="Filtra vídeos de resultados prévios (via stdin)")
    p.add_argument("--duration-min", type=int, help="Duração mínima em segundos")
    p.add_argument("--duration-max", type=int, help="Duração máxima em segundos")
    p.add_argument("--keyword", "-k", help="Palavra-chave no título")
    p.add_argument("--save", "-s", metavar="FILENAME", help="Salvar resultado em JSON")

    # search-channels
    p = sub.add_parser("search-channels", help="Busca canais do YouTube por keyword")
    p.add_argument("query", help="Termo de busca (ex: headphone review)")
    p.add_argument("-m", "--max", type=int, default=10, help="Máximo de resultados (default 10)")
    p.add_argument("--save", "-s", metavar="FILENAME", help="Salvar resultado em JSON")

    # open-at
    p = sub.add_parser("open-at", help="Abre vídeo no Chrome a partir de timestamp específico")
    p.add_argument("url", help="URL ou ID do vídeo")
    p.add_argument("timestamp", help="Timestamp em segundos (int) ou formato '1m30s', '1h2m3s'")
    p.add_argument("--save", "-s", metavar="FILENAME", help="Salvar resultado em JSON")

    # search-videos
    p = sub.add_parser("search-videos", help="Busca vídeos do YouTube por keyword")
    p.add_argument("query", help="Termo de busca (ex: best headphone 2025)")
    p.add_argument("-m", "--max", type=int, default=10, help="Máximo de resultados (default 10)")
    p.add_argument("--save", "-s", metavar="FILENAME", help="Salvar resultado em JSON")

    args = parser.parse_args()

    def output_result(data, save_path=None):
        """Imprime JSON e salva se --save for especificado"""
        json_str = json.dumps(data, indent=2, ensure_ascii=False)
        print(json_str)
        if save_path:
            _save_json(data, save_path)

    # Ler do stdin se comando for filter
    if args.cmd == "filter":
        input_data = sys.stdin.read()
        try:
            videos = json.loads(input_data)
        except:
            videos = []

        if args.duration_min or args.duration_max:
            videos = filter_videos_by_duration(videos, args.duration_min, args.duration_max)
        if args.keyword:
            videos = filter_videos_by_title(videos, args.keyword)

        output_result(videos, getattr(args, 'save', None))
        sys.exit(0)

    # Comandos principais
    if args.cmd == "list-channel":
        max_results = args.max
        keyword_filter = args.keyword

        if keyword_filter:
            # Keyword: buscar TODOS (modo rápido sem enrich), filtrar, depois enrich nos resultados finais
            result = list_channel_videos(args.channel, args.filter, None, args.lang, use_enrich=False)
            result = filter_videos_by_title(result, keyword_filter)
            if args.duration_min or args.duration_max:
                result = filter_videos_by_duration(result, args.duration_min, args.duration_max)
            if max_results:
                result = result[:max_results]
            # Enrich só os resultados finais (poucos vídeos)
            if result:
                enriched = []
                for v in result:
                    info = get_video_info(v["id"])
                    if "error" not in info and info.get("id"):
                        enriched.append(info)
                result = enriched
        else:
            # Sem keyword: modo rápido com limit direto
            result = list_channel_videos(args.channel, args.filter, max_results, args.lang, use_enrich=False)
            if args.duration_min or args.duration_max:
                result = filter_videos_by_duration(result, args.duration_min, args.duration_max)
        output_result(result, getattr(args, 'save', None))

    elif args.cmd == "video-info":
        result = get_video_info(args.url)
        output_result(result, getattr(args, 'save', None))

    elif args.cmd == "search-channel":
        result = search_channel(args.query)
        output_result(result, getattr(args, 'save', None))

    elif args.cmd == "transcript":
        result = extract_transcript(args.url, args.lang, args.output_dir, args.return_content, args.timestamp)
        output_result(result, getattr(args, 'save', None))

    elif args.cmd == "batch-transcript":
        result = batch_extract_transcripts(args.channel, args.lang, args.output_dir, args.max)
        output_result(result, getattr(args, 'save', None))

    elif args.cmd == "search-channels":
        result = search_channels(args.query, args.max)
        output_result(result, getattr(args, 'save', None))

    elif args.cmd == "search-videos":
        result = search_videos(args.query, args.max)
        output_result(result, getattr(args, 'save', None))

    elif args.cmd == "channel-info":
        result = get_channel_info(args.channel)
        output_result(result, getattr(args, 'save', None))

    elif args.cmd == "open-at":
        url = build_timestamp_url(args.url, args.timestamp, buffer_seconds=20)
        open_video_at(args.url, args.timestamp, buffer_seconds=20)
        result = {"url": url, "timestamp": args.timestamp}
        output_result(result, getattr(args, 'save', None))