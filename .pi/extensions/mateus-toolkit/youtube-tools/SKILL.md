---
name: youtube-tools
description: Busca técnica de conteúdo em vídeos e canais do YouTube para agentes de IA. Use search-videos, list-channel, transcript e outros comandos para pesquisar e extrair dados do YouTube.
---

# YouTube Tools - Skill

## Objetivo

Busca técnica de conteúdo em vídeos e canais do YouTube para agentes de IA.
O fluxo completo é:

```
1. BUSCAR vídeos por keyword (description + título)
2. ENRIQUECER com dump-json (view_count, upload_date, duration, channel)
3. EXTRAIR transcrições para análise técnica do conteúdo
```

**Buscas demoram.** Quanto mais resultados (`-m`), mais lento. Use valores pequenos (3-10).

---

## Arquitetura

```
youtube-tools/
├── SKILL.md           ← Este arquivo
└── youtube_tools.py   ← Ferramenta Python CLI
```

**Estratégia de enrichment:** buscas usam flat-playlist rápido para IDs, depois
faz dump-json individual em cada resultado para obter dados completos
(upload_date, view_count, like_count, description).

---

## Como usar

```bash
python "C:\Users\Administrador\.config\opencode\skills\youtube-tools\youtube_tools.py" [COMMAND] [ARGS]
```

---

## Comandos

### search-videos — Busca vídeos por keyword

Busca YouTube e enrich cada resultado com dados completos.

```bash
python youtube_tools.py search-videos "headphone review" -m 5
```

**Output:**
```json
[
  {
    "id": "zakPRMGlRbw",
    "title": "The BEST Headphones of the Year...",
    "description": "What are the best Headphones of 2025...",
    "url": "https://www.youtube.com/watch?v=zakPRMGlRbw",
    "upload_date": "20260101",
    "duration": "00:12:22",
    "view_count": 267724,
    "like_count": 3353,
    "channel": "This is Tech Today",
    "channel_id": "UCEAMLkMKtq6YhmaZdUT1ywA"
  }
]
```

**Nota:** `-m` = número de resultados. Mais resultados = mais tempo (1 busca + N dumps).
Para 3 resultados: ~12s. Para 10 resultados: ~40s.

---

### search-channels — Busca canais por keyword

Busca canais e enrich cada um com subscriber count.

```bash
python youtube_tools.py search-channels "tech reviews" -m 3
```

**Output:**
```json
[
  {
    "channel_id": "UCD3ivAQE5WPT0wUVupxoXDQ",
    "name": "Nathan",
    "subscribers": 268000,
    "url": "https://www.youtube.com/watch?v=J3zd7Kd8YD0"
  }
]
```

---

### list-channel — Lista vídeos de um canal

**Modo rápido (sem keyword, com -m):**
```bash
python youtube_tools.py list-channel "@MINDTHEHEADPHONE" -m 3
```
Busca apenas os primeiros N vídeos. Rápido (~3s).

**Modo completo (com --keyword):**
```bash
python youtube_tools.py list-channel "@MINDTHEHEADPHONE" --keyword "KZ" -m 3
```
1. Busca TODOS os vídeos do canal (sem limit)
2. Filtra por keyword no título e descrição
3. Limita ao `-m`
4. Enrich só os resultados filtrados com dump-json

**Output:**
```json
[
  {
    "id": "sCPe1CakBUQ",
    "title": "Como anda a KZ em 2026? ...",
    "description": "...",
    "url": "https://www.youtube.com/watch?v=sCPe1CakBUQ",
    "upload_date": "20260511",
    "duration": "00:20:50",
    "view_count": 27675,
    "like_count": 3447,
    "channel": "MIND THE HEADPHONE",
    "channel_id": "UC7fN3sq7h2BDFtBrzXWo4Zg"
  }
]
```

**Filtros adicionais:**
```bash
--filter videos|shorts|streams|playlists   # tipo de conteúdo
--duration-min 300                         # duração mínima em segundos
--duration-max 1800                         # duração máxima em segundos
--lang pt-BR                                # filtrar por idioma
```

---

### channel-info — Informações completas de um canal

```bash
python youtube_tools.py channel-info "@MINDTHEHEADPHONE"
```

**Output:**
```json
{
  "channel_id": "UC7fN3sq7h2BDFtBrzXWo4Zg",
  "name": "MIND THE HEADPHONE",
  "subscribers": 411000,
  "url": "https://www.youtube.com/watch?v=sCPe1CakBUQ"
}
```

---

### video-info — Informações detalhadas de um vídeo

```bash
python youtube_tools.py video-info "https://www.youtube.com/watch?v=zakPRMGlRbw"
```

**Output:**
```json
{
  "id": "zakPRMGlRbw",
  "title": "The BEST Headphones...",
  "description": "What are the best Headphones of 2025...",
  "url": "https://www.youtube.com/watch?v=zakPRMGlRbw",
  "upload_date": "20260101",
  "duration": "00:12:22",
  "view_count": 267724,
  "like_count": 3353,
  "channel": "This is Tech Today",
  "channel_id": "UCEAMLkMKtq6YhmaZdUT1ywA"
}
```

---

### transcript — Extrai transcrição de um vídeo

```bash
# Retorna JSON com path do arquivo
python youtube_tools.py transcript "URL" --lang pt-BR

# Retorna texto direto (para agentes de IA)
python youtube_tools.py transcript "URL" --return-content

# Retorna texto COM timestamps [HH:MM:SS]
python youtube_tools.py transcript "URL" --timestamp
```

**Output (sem --return-content):**
```json
{
  "code": 0,
  "filename": "nome-do-video.pt-BR.vtt",
  "stdout": "...",
  "stderr": ""
}
```

**Output (com --return-content):** Texto puro da transcrição, sem timestamps. Ideal para análise técnica.

**Output (com --timestamp):** Texto puro com timestamp [HH:MM:SS] antes de cada trecho. Exemplo:
```
[00:00:01.36] ♪ We're no strangers to love ♪ [00:00:18.64] ♪ You know the rules and so do I ♪
```

---

### batch-transcript — Extrai transcrições de um canal inteiro

```bash
python youtube_tools.py batch-transcript "@CANAL" --lang pt-BR --output-dir transcripts --max 10
```

**Output:**
```json
{
  "success": true,
  "output_dir": "transcripts",
  "files_generated": 3,
  "files": ["2026-05-11_Como anda a KZ em 2026...", "..."],
  "stdout_preview": "..."
}
```

---

### open-at — Abre vídeo no navegador a partir de timestamp

Abre o vídeo no Chrome a partir de um tempo específico.

```bash
# Segundos inteiros
python youtube_tools.py open-at "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 90

# Formato humanizado
python youtube_tools.py open-at "https://www.youtube.com/watch?v=dQw4w9WgXcQ" "1m30s"
```

**Output:**
```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s",
  "timestamp": "90"
}
```

**Nota:** A URL é construída automaticamente — usa `?t=` para links curtos (youtu.be) e `&t=` para links longos.

---

### filter — Filtra vídeos via stdin (para pipelines)

```bash
# Filtrar por duração
python youtube_tools.py list-channel "@CANAL" -m 50 | python youtube_tools.py filter --duration-min 300 --duration-max 1800

# Filtrar por keyword no título
python youtube_tools.py list-channel "@CANAL" | python youtube_tools.py filter --keyword "review"
```

---

### search-channel — Busca rápida de canal por @username

```bash
python youtube_tools.py search-channel "@MINDTHEHEADPHONE"
```

**Output:**
```json
{
  "channel_id": "UC7fN3sq7h2BDFtBrzXWo4Zg",
  "name": "MIND THE HEADPHONE",
  "url": "https://www.youtube.com/watch?v=sCPe1CakBUQ"
}
```

---

## Salvar resultados em JSON

Todos os comandos aceitam `--save NOME.json` ou `-s NOME.json`:

```bash
python youtube_tools.py search-videos "headphone review" -m 5 --save resultados.json

python youtube_tools.py channel-info "@CANAL" -s canal.json
```

---

## Funções Python (importáveis)

```python
import sys
sys.path.insert(0, r"C:\Users\Administrador\.config\opencode\skills\youtube-tools")
from youtube_tools import (
    list_channel_videos,
    get_video_info,
    search_channel,
    search_channels,
    search_videos,
    get_channel_info,
    extract_transcript,
    batch_extract_transcripts,
    filter_videos_by_title,
    filter_videos_by_duration,
    build_timestamp_url,
    open_video_at,
)

# Buscar vídeos com enrich completo
videos = search_videos("headphone review", max_results=5)

# Listar canal (rápido, sem enrich)
videos = list_channel_videos("@CANAL", "videos", max_results=10)

# Listar canal com keyword (busca todos + filtra + enrich resultados)
videos = list_channel_videos("@CANAL", "videos", None)
videos = filter_videos_by_title(videos, "KZ")
videos = videos[:3]
# enrich manual:
for v in videos:
    info = get_video_info(v["id"])

# Transcrição como texto
# Transcrição como texto (sem timestamp)
transcript = extract_transcript("URL", language="pt-BR", return_content=True)

# Transcrição com timestamps
transcript = extract_transcript("URL", language="pt-BR", return_content=True, include_timestamp=True)

# Abrir vídeo no Chrome a partir de 1m30s
url = build_timestamp_url("https://www.youtube.com/watch?v=ID", "1m30s")
open_video_at("https://www.youtube.com/watch?v=ID", 90)
```

---

## Formato de Saída para IA

Todos os comandos retornam JSON estruturado. Sem "NA", sem campos vazios —
só dados reais.

| Campo | Descrição |
|-------|-----------|
| `id` | ID do vídeo (11 caracteres) |
| `title` | Título |
| `description` | Descrição (truncada em 2000 chars) |
| `upload_date` | Data YYYYMMDD |
| `duration` | Duração HH:MM:SS |
| `view_count` | Número de views (int) |
| `like_count` | Número de likes (int) |
| `channel` | Nome do canal |
| `channel_id` | ID do canal |
| `subscribers` | Número de inscritos |
| `url` | URL completa |

---

## Avisos de Performance

**Buscas são lentas.** O enrichment faz dump-json individual em cada resultado.

| Comando | Tempo aproximado |
|---------|------------------|
| `search-videos -m 3` | ~12s |
| `search-videos -m 10` | ~40s |
| `list-channel --keyword X -m 3` | ~15-20s |
| `list-channel -m 3` (rápido) | ~3s |
| `channel-info` | ~8s |
| `search-channels -m 3` | ~15s |
| `video-info` | ~2s |
| `transcript --return-content` | ~5-10s |
| `transcript --timestamp` | ~5-10s |

**Dicas:**
- Use `-m` pequeno (3-10) para testes
- Busque com `--save` para não perder resultados longos
- `list-channel` sem `--keyword` é rápido (~3s para 3 resultados)
- `list-channel` com `--keyword` busca TODOS os vídeos do canal antes de filtrar

---

## Troubleshooting

### yt-dlp não encontrado
```powershell
python -m yt_dlp --version
```

### UnicodeEncodeError
O tool já configura stdout com UTF-8 wrapper automaticamente.

### Legendas não disponíveis
```bash
# Tentar todos os idiomas
python youtube_tools.py transcript "URL" --lang all
```

### Precisa de ffmpeg
```powershell
winget install ffmpeg
```