import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import ytplModule from "ytpl";
import * as transcriptModule from "youtube-transcript";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const ytpl = ytplModule.default ?? ytplModule;
const YoutubeTranscript =
  transcriptModule.YoutubeTranscript ??
  transcriptModule.default?.YoutubeTranscript ??
  transcriptModule.default ??
  transcriptModule;

const DEFAULT_CATEGORIES = [
  "Business",
  "Marketing",
  "Vente",
  "Productivite",
  "Mindset",
  "Sport / sante",
  "Developpement personnel",
  "Finance",
  "Creation de contenu",
  "IA / automatisation",
  "Autre",
];

const CATEGORY_KEYWORDS = {
  Business: ["business", "marche", "strategie", "modele", "client", "croissance", "offre", "positionnement"],
  Marketing: ["marketing", "audience", "message", "marque", "trafic", "conversion", "campagne", "visibilite"],
  Vente: ["vente", "prospect", "closing", "negociation", "objection", "appel", "prix", "relance"],
  Productivite: ["productivite", "priorite", "temps", "focus", "routine", "systeme", "organisation", "tache"],
  Mindset: ["mindset", "peur", "discipline", "courage", "confiance", "motivation", "blocage", "risque"],
  "Sport / sante": ["sport", "sante", "sommeil", "nutrition", "entrainement", "energie", "corps", "recuperation"],
  "Developpement personnel": [
    "habitude",
    "objectif",
    "apprentissage",
    "progression",
    "decision",
    "clarte",
    "relation",
    "vie",
  ],
  Finance: ["finance", "argent", "investissement", "cash", "budget", "revenu", "rentabilite", "cout"],
  "Creation de contenu": ["contenu", "video", "youtube", "script", "storytelling", "creator", "publication", "format"],
  "IA / automatisation": ["ia", "ai", "automatisation", "prompt", "agent", "outil", "workflow", "donnees"],
  Autre: [],
};

const STOPWORDS = new Set([
  "alors",
  "apres",
  "avec",
  "avoir",
  "comme",
  "dans",
  "donc",
  "elle",
  "elles",
  "etre",
  "faire",
  "faut",
  "leur",
  "mais",
  "nous",
  "pour",
  "plus",
  "quand",
  "sans",
  "tout",
  "tres",
  "vous",
  "votre",
  "that",
  "this",
  "with",
  "from",
  "they",
  "have",
  "what",
  "when",
  "your",
  "about",
  "there",
  "would",
]);

main().catch((error) => {
  console.error(`\nErreur: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.config || "config.json");
  const mergedConfig = normalizeConfig({ ...config, ...args });
  const outFile = path.resolve(rootDir, mergedConfig.out || "data.json");
  const existingData = await readJsonIfExists(outFile);
  const existingIndex = buildExistingIndex(existingData);

  console.log("Lecture de la playlist...");
  const videos = await fetchPlaylistVideos(mergedConfig.playlist_url, mergedConfig.max_videos);
  console.log(`${videos.length} video(s) trouvee(s).`);

  const items = [];
  const videoResults = [];
  const errors = [];
  const useOpenAI = shouldUseOpenAI(mergedConfig);

  for (const [index, video] of videos.entries()) {
    console.log(`\n[${index + 1}/${videos.length}] ${video.title}`);

    const videoKey = getVideoKey(video);
    const existingVideo = existingIndex.videos.get(videoKey);
    const existingItems = existingIndex.items.get(videoKey) || [];
    if (!mergedConfig.force && existingVideo?.transcript_status === "available" && existingItems.length) {
      const reusedItems = reuseExistingItems(existingItems, video, mergedConfig).slice(0, mergedConfig.max_items_per_video);
      items.push(...reusedItems);
      videoResults.push({
        ...video,
        transcript_status: "available",
        transcript_language: existingVideo.transcript_language || "unknown",
        output_language: existingVideo.output_language || mergedConfig.target_language,
        translation_status:
          existingVideo.translation_status ||
          getTranslationStatus(existingVideo.transcript_language, mergedConfig.target_language),
        item_count: reusedItems.length,
      });
      console.log(`  - deja analysee, ${reusedItems.length} idee(s) reutilisee(s).`);
      continue;
    }

    const transcriptResult = await fetchTranscript(video, mergedConfig.transcript_languages);
    if (!transcriptResult.ok) {
      const message = transcriptResult.error || "Transcription indisponible.";
      console.warn(`  - ignoree: ${message}`);
      errors.push({ video_title: video.title, video_url: video.url, reason: message });
      videoResults.push({ ...video, transcript_status: "missing", item_count: 0, error: message });
      continue;
    }

    if (
      needsTranslation(transcriptResult.language, mergedConfig.target_language) &&
      !useOpenAI &&
      mergedConfig.require_ai_translation
    ) {
      const message =
        "Transcription anglaise disponible, mais OPENAI_API_KEY est requis pour produire une version francaise fiable.";
      console.warn(`  - ignoree: ${message}`);
      errors.push({
        video_title: video.title,
        video_url: video.url,
        transcript_language: transcriptResult.language,
        reason: message,
      });
      videoResults.push({
        ...video,
        transcript_status: "translation_required",
        transcript_language: transcriptResult.language,
        output_language: mergedConfig.target_language,
        item_count: 0,
        error: message,
      });
      continue;
    }

    const transcriptText = transcriptToText(transcriptResult.parts);
    if (!transcriptText) {
      const message = "Transcription vide apres nettoyage.";
      console.warn(`  - ignoree: ${message}`);
      errors.push({ video_title: video.title, video_url: video.url, reason: message });
      videoResults.push({ ...video, transcript_status: "empty", item_count: 0, error: message });
      continue;
    }

    const ideas = useOpenAI
      ? await analyzeWithOpenAI(video, transcriptText, mergedConfig, transcriptResult.language)
      : analyzeHeuristically(video, transcriptText, mergedConfig);

    const normalizedIdeas = ideas
      .map((idea) => normalizeIdea(idea, video, mergedConfig.categories, transcriptResult.language, mergedConfig))
      .filter((idea) => idea.title && idea.summary)
      .slice(0, mergedConfig.max_items_per_video);

    items.push(...normalizedIdeas);
    videoResults.push({
      ...video,
      transcript_status: "available",
      transcript_language: transcriptResult.language,
      output_language: mergedConfig.target_language,
      translation_status: getTranslationStatus(transcriptResult.language, mergedConfig.target_language),
      item_count: normalizedIdeas.length,
    });
    console.log(`  - ${normalizedIdeas.length} idee(s) ajoutee(s).`);
  }

  const data = buildOutput(mergedConfig, videoResults, items, errors, useOpenAI);
  const stableData = preserveGeneratedAtIfUnchanged(data, existingData);
  await fs.writeFile(outFile, `${JSON.stringify(stableData, null, 2)}\n`, "utf8");

  console.log(`\nTermine. Fichier genere: ${path.relative(rootDir, outFile)}`);
  console.log("Aucune transcription brute n'a ete stockee dans data.json.");
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replaceAll("-", "_");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

async function loadConfig(configFile) {
  const configPath = path.resolve(rootDir, configFile);
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeConfig(config) {
  const playlistUrl = config.playlist || config.playlist_url;
  if (!playlistUrl) {
    throw new Error("Aucune playlist fournie. Ajoutez playlist_url dans config.json ou utilisez --playlist.");
  }

  return {
    ...config,
    playlist_url: playlistUrl,
    categories: Array.isArray(config.categories) && config.categories.length ? config.categories : DEFAULT_CATEGORIES,
    transcript_languages:
      Array.isArray(config.transcript_languages) && config.transcript_languages.length
        ? config.transcript_languages
        : ["fr", "en"],
    max_videos: Number(config.max_videos || 0),
    max_items_per_video: Math.max(1, Number(config.max_items_per_video || 5)),
    analyzer: config.ai ? "openai" : config.analyzer || "auto",
    openai_model: config.openai_model || process.env.OPENAI_MODEL || "gpt-4.1-mini",
    target_language: config.target_language || "fr",
    require_ai_translation: config.require_ai_translation !== false && config.require_ai_translation !== "false",
    force: config.force === true || config.force === "true" || config.force === "1",
  };
}

async function fetchPlaylistVideos(playlistUrl, maxVideos) {
  const playlist = await ytpl(playlistUrl, { pages: Infinity });
  const items = playlist.items || [];
  const limitedItems = maxVideos > 0 ? items.slice(0, maxVideos) : items;

  return limitedItems.map((item) => ({
    id: item.id,
    title: item.title || "Video sans titre",
    url: item.shortUrl || item.url || `https://www.youtube.com/watch?v=${item.id}`,
    channel: item.author?.name || item.author || "",
    duration: item.duration || secondsToDuration(item.durationSec),
  }));
}

async function fetchTranscript(video, languages) {
  if (!YoutubeTranscript?.fetchTranscript) {
    return {
      ok: false,
      error: "Le module youtube-transcript ne fournit pas fetchTranscript.",
    };
  }

  const targets = [video.id, video.url].filter(Boolean);
  const failures = [];

  for (const language of languages) {
    for (const target of targets) {
      try {
        const parts = await YoutubeTranscript.fetchTranscript(target, { lang: language });
        if (Array.isArray(parts) && parts.length) {
          return { ok: true, language, parts };
        }
      } catch (error) {
        failures.push(`${language}: ${error.message}`);
      }
    }
  }

  return {
    ok: false,
    error: failures.at(-1) || "Aucune transcription disponible dans les langues configurees.",
  };
}

function transcriptToText(parts) {
  return parts
    .map((part) => cleanText(part.text || ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\[(musique|music|applaudissements|applause)\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldUseOpenAI(config) {
  if (config.analyzer === "heuristic") return false;
  if (config.analyzer === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY est requis avec analyzer=openai.");
  }
  return Boolean(process.env.OPENAI_API_KEY);
}

async function analyzeWithOpenAI(video, transcriptText, config, transcriptLanguage) {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const chunks = chunkText(transcriptText, 18000);
  const candidates = [];
  const languageInstruction =
    transcriptLanguage && transcriptLanguage !== config.target_language
      ? `La transcription source est en ${transcriptLanguage}. Traduis mentalement le contenu et produis exclusivement des titres et resumes en francais.`
      : "Produis exclusivement des titres et resumes en francais.";

  for (const [index, chunk] of chunks.entries()) {
    const completion = await client.chat.completions.create({
      model: config.openai_model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `Tu es un analyste editorial. Tu extrais uniquement les idees actionnables et utiles d'une transcription YouTube. ${languageInstruction} Tu ne cites jamais de longs passages, tu ne recopies pas la transcription et tu reformules en francais clair, professionnel et concis. Tu reponds en JSON strict.`,
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              consigne:
                "Analyse cet extrait de transcription. Retourne un objet JSON avec une cle items. Chaque item doit contenir category, title et summary. Evite repetitions, introductions, anecdotes faibles et citations longues.",
              max_items: config.max_items_per_video,
              categories: config.categories,
              video: {
                title: video.title,
                channel: video.channel,
                url: video.url,
              },
              transcript_language: transcriptLanguage,
              output_language: config.target_language,
              chunk_index: index + 1,
              chunk_count: chunks.length,
              transcript_excerpt: chunk,
            },
            null,
            2,
          ),
        },
      ],
    });

    const parsed = parseJsonObject(completion.choices?.[0]?.message?.content);
    if (Array.isArray(parsed.items)) {
      candidates.push(...parsed.items);
    }
  }

  if (candidates.length <= config.max_items_per_video) {
    return candidates;
  }

  const completion = await client.chat.completions.create({
    model: config.openai_model,
    temperature: 0.15,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Tu consolides des idees deja reformulees en francais. Tu supprimes les doublons, gardes les points les plus actionnables et reponds en JSON strict.",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            consigne:
              "Garde les meilleures idees pour cette video. Retourne {\"items\": [...]}. Chaque item doit contenir category, title et summary.",
            max_items: config.max_items_per_video,
            categories: config.categories,
            video_title: video.title,
            transcript_language: transcriptLanguage,
            output_language: config.target_language,
            candidates,
          },
          null,
          2,
        ),
      },
    ],
  });

  const parsed = parseJsonObject(completion.choices?.[0]?.message?.content);
  return Array.isArray(parsed.items) ? parsed.items : candidates.slice(0, config.max_items_per_video);
}

function analyzeHeuristically(video, transcriptText, config) {
  const windows = buildWindows(transcriptText, 900);
  const scored = windows
    .map((text) => ({
      text,
      score: scoreText(text),
      category: classifyCategory(text, config.categories),
      keywords: extractKeywords(text, 4),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  for (const entry of scored) {
    if (selected.length >= config.max_items_per_video) break;
    if (selected.some((existing) => tooSimilar(existing.keywords, entry.keywords))) continue;
    selected.push(entry);
  }

  return selected.map((entry) => ({
    category: entry.category,
    title: buildHeuristicTitle(entry.category, entry.keywords),
    summary: buildHeuristicSummary(entry.category, entry.keywords, video.title),
  }));
}

function buildWindows(text, targetLength) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 30);

  const windows = [];
  let current = "";

  for (const sentence of sentences) {
    if ((current + " " + sentence).length > targetLength && current) {
      windows.push(current.trim());
      current = sentence;
    } else {
      current = `${current} ${sentence}`.trim();
    }
  }

  if (current) windows.push(current.trim());
  return windows;
}

function scoreText(text) {
  const lower = normalize(text);
  const actionWords = [
    "action",
    "appliquer",
    "strategie",
    "systeme",
    "methode",
    "etape",
    "objectif",
    "client",
    "revenu",
    "mesurer",
    "priorite",
    "decision",
    "process",
    "workflow",
    "automatis",
  ];
  const fillerWords = ["bonjour", "abonne", "like", "commentaire", "chaine", "intro", "sponsor"];

  const actionScore = actionWords.reduce((score, word) => score + (lower.includes(word) ? 2 : 0), 0);
  const fillerPenalty = fillerWords.reduce((score, word) => score + (lower.includes(word) ? 1 : 0), 0);
  const lengthScore = Math.min(6, Math.floor(text.length / 180));
  return actionScore + lengthScore - fillerPenalty;
}

function classifyCategory(text, categories) {
  const lower = normalize(text);
  let best = { category: "Autre", score: 0 };

  for (const category of categories) {
    const keywords = CATEGORY_KEYWORDS[category] || [];
    const score = keywords.reduce((total, keyword) => total + (lower.includes(normalize(keyword)) ? 1 : 0), 0);
    if (score > best.score) {
      best = { category, score };
    }
  }

  return best.category;
}

function extractKeywords(text, limit) {
  const counts = new Map();
  normalize(text)
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length > 4 && !STOPWORDS.has(word))
    .forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function buildHeuristicTitle(category, keywords) {
  const subject = keywords.length ? titleCase(keywords.slice(0, 3).join(" / ")) : "Point cle";
  const verbs = {
    Business: "Structurer",
    Marketing: "Clarifier",
    Vente: "Renforcer",
    Productivite: "Prioriser",
    Mindset: "Ancrer",
    "Sport / sante": "Stabiliser",
    "Developpement personnel": "Faire progresser",
    Finance: "Piloter",
    "Creation de contenu": "Transformer",
    "IA / automatisation": "Automatiser",
    Autre: "Retenir",
  };
  return `${verbs[category] || "Retenir"} ${subject}`;
}

function buildHeuristicSummary(category, keywords, videoTitle) {
  const subject = keywords.length ? keywords.join(", ") : "le sujet central";
  const templates = {
    Business: `Transformer ${subject} en decision business concrete: definir le resultat attendu, choisir un indicateur simple et agir sur l'etape qui cree le plus de valeur.`,
    Marketing: `Rendre ${subject} plus utile commercialement: partir du besoin de l'audience, formuler un message clair et mesurer la reaction obtenue.`,
    Vente: `Utiliser ${subject} pour rendre la vente plus precise: qualifier le besoin, traiter l'objection principale et proposer une prochaine action explicite.`,
    Productivite: `Aborder ${subject} comme un systeme: supprimer les distractions, fixer une priorite observable et repeter le processus avant de l'optimiser.`,
    Mindset: `Relier ${subject} a un comportement concret: reduire l'hesitation, choisir une action courte et juger le progres sur les faits plutot que sur l'envie.`,
    "Sport / sante": `Stabiliser ${subject} avec une logique durable: privilegier la regularite, suivre les signaux du corps et ajuster l'effort progressivement.`,
    "Developpement personnel": `Faire de ${subject} un levier de progression: clarifier l'intention, creer une habitude simple et revoir regulierement ce qui fonctionne.`,
    Finance: `Piloter ${subject} avec discipline: connaitre les flux, limiter les decisions impulsives et relier chaque choix a un objectif financier mesurable.`,
    "Creation de contenu": `Transformer ${subject} en contenu plus fort: isoler une idee nette, choisir un format adapte et retirer tout ce qui dilue le message.`,
    "IA / automatisation": `Automatiser ${subject} avec prudence: decrire le workflow, garder un controle humain sur la sortie et mesurer le temps reellement gagne.`,
    Autre: `Point important repere dans "${videoTitle}": clarifier ${subject}, le transformer en action simple et verifier rapidement son impact.`,
  };
  return templates[category] || templates.Autre;
}

function tooSimilar(a, b) {
  if (!a.length || !b.length) return false;
  const intersection = a.filter((word) => b.includes(word));
  return intersection.length >= Math.min(2, a.length, b.length);
}

function parseJsonObject(content) {
  if (!content) return {};
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

function normalizeIdea(idea, video, categories, transcriptLanguage, config) {
  const category = categories.includes(idea.category) ? idea.category : classifyCategory(`${idea.title} ${idea.summary}`, categories);
  const title = trimText(cleanText(idea.title || ""), 90);
  const summary = trimText(cleanText(idea.summary || ""), 520);

  return {
    id: slugify(`${video.id}-${category}-${title}`),
    video_id: video.id,
    category,
    title,
    summary,
    source_video: video.title,
    video_url: video.url,
    channel: video.channel,
    duration: video.duration,
    transcript_language: transcriptLanguage || "unknown",
    output_language: config.target_language,
  };
}

function buildOutput(config, videos, items, errors, useOpenAI) {
  const grouped = config.categories.map((category) => ({
    category,
    items: items.filter((item) => item.category === category),
  }));

  return {
    generated_at: new Date().toISOString(),
    playlist_url: config.playlist_url,
    categories: config.categories,
    videos,
    items,
    grouped,
    metadata: {
      analyzer: useOpenAI ? "openai" : "heuristic",
      model: useOpenAI ? config.openai_model : null,
      notes:
        "Les transcriptions completes sont utilisees uniquement pendant l'analyse locale. Les videos anglaises sont analysees depuis leur transcription anglaise et restituees en francais, sans stocker la transcription brute.",
      errors,
    },
  };
}

function buildExistingIndex(existingData) {
  const videos = new Map();
  const items = new Map();
  if (!existingData || typeof existingData !== "object") {
    return { videos, items };
  }

  for (const video of existingData.videos || []) {
    const key = getVideoKey(video);
    if (key) videos.set(key, video);
  }

  const existingItems = Array.isArray(existingData.items)
    ? existingData.items
    : Array.isArray(existingData.grouped)
      ? existingData.grouped.flatMap((group) => group.items || [])
      : [];

  for (const item of existingItems) {
    const key = getVideoKey({ id: item.video_id, url: item.video_url, title: item.source_video });
    if (!key) continue;
    if (!items.has(key)) items.set(key, []);
    items.get(key).push(item);
  }

  return { videos, items };
}

function reuseExistingItems(items, video, config) {
  return items.map((item) => ({
    ...item,
    id: item.id || slugify(`${video.id}-${item.category}-${item.title}`),
    video_id: video.id,
    source_video: video.title,
    video_url: video.url,
    channel: video.channel,
    duration: video.duration,
    output_language: item.output_language || config.target_language,
  }));
}

function getVideoKey(video) {
  return video?.id || extractVideoId(video?.url) || video?.url || "";
}

function extractVideoId(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("v") || parsed.pathname.split("/").filter(Boolean).at(-1) || "";
  } catch {
    return "";
  }
}

function needsTranslation(sourceLanguage, targetLanguage) {
  if (!sourceLanguage || !targetLanguage) return false;
  return normalizeLanguage(sourceLanguage) !== normalizeLanguage(targetLanguage);
}

function getTranslationStatus(sourceLanguage, targetLanguage) {
  return needsTranslation(sourceLanguage, targetLanguage) ? `translated_${sourceLanguage}_to_${targetLanguage}` : "native";
}

function normalizeLanguage(language) {
  return String(language).toLowerCase().split("-")[0];
}

function preserveGeneratedAtIfUnchanged(nextData, existingData) {
  if (!existingData?.generated_at) return nextData;
  const nextStable = JSON.stringify(stripVolatileFields(nextData));
  const existingStable = JSON.stringify(stripVolatileFields(existingData));
  if (nextStable === existingStable) {
    return { ...nextData, generated_at: existingData.generated_at };
  }
  return nextData;
}

function stripVolatileFields(data) {
  if (!data || typeof data !== "object") return data;
  return {
    ...data,
    generated_at: null,
  };
}

function chunkText(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function trimText(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}...`;
}

function normalize(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function titleCase(value) {
  return value
    .split(" ")
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function slugify(value) {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
}

function secondsToDuration(seconds) {
  if (!seconds) return "";
  const total = Number(seconds);
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}
