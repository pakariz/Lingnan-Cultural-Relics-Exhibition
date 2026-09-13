const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const projectRoot = path.resolve(__dirname, "..");
const modelsDir = path.join(projectRoot, "models");
const dataFile = path.join(__dirname, "data", "artifacts.json");
const allowedExtensions = new Set([".glb", ".gltf", ".obj"]);

fs.mkdirSync(modelsDir, { recursive: true });
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
if (!fs.existsSync(dataFile)) {
  fs.writeFileSync(dataFile, "[]", "utf8");
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, modelsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeBase = path
      .basename(file.originalname, ext)
      .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "artifact-model";
    cb(null, `${Date.now()}-${safeBase}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      cb(new Error("仅支持 .glb、.gltf、.obj 模型文件"));
      return;
    }
    cb(null, true);
  },
});

function readArtifacts() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch (_error) {
    return [];
  }
}

function writeArtifacts(artifacts) {
  fs.writeFileSync(dataFile, JSON.stringify(artifacts, null, 2), "utf8");
}

function createId(prefix = "artifact") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toModelUrl(modelPath) {
  return modelPath ? `/models/${modelPath.replace(/\\/g, "/")}` : null;
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeModelSettings(source = {}) {
  return {
    emissiveIntensity: Math.max(0, toFiniteNumber(source.emissiveIntensity, 0.35)),
    modelScale: Math.max(0.05, toFiniteNumber(source.modelScale, 1)),
    posX: toFiniteNumber(source.posX, 0),
    posY: toFiniteNumber(source.posY, -0.2),
    posZ: toFiniteNumber(source.posZ, 0),
  };
}

function normalizeHexColor(value, fallback) {
  const s = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
}

function normalizeEnvironmentSettings(source = {}) {
  return {
    bgColor: normalizeHexColor(source.bgColor, "#000000"),
    envLightIntensity: Math.max(0, toFiniteNumber(source.envLightIntensity, 1)),
    extraLightColor: normalizeHexColor(source.extraLightColor, "#ffd8b0"),
    extraLightIntensity: Math.max(0, toFiniteNumber(source.extraLightIntensity, 0.25)),
    extraLightX: toFiniteNumber(source.extraLightX, 0),
    extraLightY: toFiniteNumber(source.extraLightY, 2.2),
    extraLightZ: toFiniteNumber(source.extraLightZ, 1.8),
  };
}

function walkModels(currentDir, baseDir = currentDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkModels(fullPath, baseDir));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (allowedExtensions.has(ext)) {
      files.push(path.relative(baseDir, fullPath));
    }
  }

  return files;
}

function createDefaultArtifactFromModel(modelPath, existing) {
  const ext = path.extname(modelPath);
  const baseName = path.basename(modelPath, ext);
  const modelSettings = normalizeModelSettings(existing);
  const envSettings = normalizeEnvironmentSettings(existing);
  return {
    id: existing?.id || createId("scanned"),
    name: existing?.name || baseName,
    description:
      existing?.description ||
      "该文物已从 models 文件夹自动载入，请在右侧补充文物说明、年代、材质和尺寸信息。",
    era: existing?.era || "待补充",
    category: existing?.category || "未分类",
    origin: existing?.origin || "待补充",
    material: existing?.material || "待补充",
    dimensions: existing?.dimensions || "待补充",
    emissiveIntensity: modelSettings.emissiveIntensity,
    modelScale: modelSettings.modelScale,
    posX: modelSettings.posX,
    posY: modelSettings.posY,
    posZ: modelSettings.posZ,
    bgColor: envSettings.bgColor,
    envLightIntensity: envSettings.envLightIntensity,
    extraLightColor: envSettings.extraLightColor,
    extraLightIntensity: envSettings.extraLightIntensity,
    extraLightX: envSettings.extraLightX,
    extraLightY: envSettings.extraLightY,
    extraLightZ: envSettings.extraLightZ,
    modelFile: modelPath.replace(/\\/g, "/"),
    source: existing?.source || "filesystem",
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mergeArtifactsWithModels() {
  const metadataArtifacts = readArtifacts();
  const modelFiles = walkModels(modelsDir).map((item) => item.replace(/\\/g, "/"));
  const byModel = new Map();
  const byId = new Map();

  metadataArtifacts.forEach((artifact) => {
    if (artifact.modelFile) {
      byModel.set(artifact.modelFile.replace(/\\/g, "/"), artifact);
    }
    byId.set(artifact.id, artifact);
  });

  const merged = [];

  for (const modelFile of modelFiles) {
    merged.push(createDefaultArtifactFromModel(modelFile, byModel.get(modelFile)));
  }

  for (const artifact of metadataArtifacts) {
    if (!artifact.modelFile || !modelFiles.includes(artifact.modelFile.replace(/\\/g, "/"))) {
      merged.push({
        ...artifact,
        updatedAt: artifact.updatedAt || artifact.createdAt || new Date().toISOString(),
      });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const artifact of merged) {
    if (seen.has(artifact.id)) {
      continue;
    }
    seen.add(artifact.id);
    unique.push({
      ...artifact,
      modelUrl: toModelUrl(artifact.modelFile || ""),
    });
  }

  unique.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  writeArtifacts(unique.map(({ modelUrl, ...artifact }) => artifact));
  return unique;
}

function findArtifactOrThrow(id) {
  const artifacts = mergeArtifactsWithModels();
  const artifact = artifacts.find((item) => item.id === id);
  if (!artifact) {
    const error = new Error("文物不存在");
    error.statusCode = 404;
    throw error;
  }
  return artifact;
}

function deleteModelFile(modelFile) {
  if (!modelFile) {
    return;
  }
  const fullPath = path.join(modelsDir, modelFile);
  if (fullPath.startsWith(modelsDir) && fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

app.get("/api/artifacts", (_req, res) => {
  res.json(mergeArtifactsWithModels());
});

app.get("/api/artifacts/:id", (req, res, next) => {
  try {
    res.json(findArtifactOrThrow(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/artifacts", upload.single("model"), (req, res) => {
  const artifacts = mergeArtifactsWithModels().map(({ modelUrl, ...artifact }) => artifact);
  const now = new Date().toISOString();
  const modelSettings = normalizeModelSettings(req.body || {});
  const envSettings = normalizeEnvironmentSettings(req.body || {});
  const artifact = {
    id: createId(),
    name: (req.body.name || "未命名文物").trim(),
    description: (req.body.description || "").trim(),
    era: (req.body.era || "").trim(),
    category: (req.body.category || "").trim(),
    origin: (req.body.origin || "").trim(),
    material: (req.body.material || "").trim(),
    dimensions: (req.body.dimensions || "").trim(),
    emissiveIntensity: modelSettings.emissiveIntensity,
    modelScale: modelSettings.modelScale,
    posX: modelSettings.posX,
    posY: modelSettings.posY,
    posZ: modelSettings.posZ,
    bgColor: envSettings.bgColor,
    envLightIntensity: envSettings.envLightIntensity,
    extraLightColor: envSettings.extraLightColor,
    extraLightIntensity: envSettings.extraLightIntensity,
    extraLightX: envSettings.extraLightX,
    extraLightY: envSettings.extraLightY,
    extraLightZ: envSettings.extraLightZ,
    modelFile: req.file ? req.file.filename : "",
    source: req.file ? "upload" : "metadata",
    createdAt: now,
    updatedAt: now,
  };

  artifacts.push(artifact);
  writeArtifacts(artifacts);
  res.status(201).json({ success: true, artifact: mergeArtifactsWithModels().find((item) => item.id === artifact.id) });
});

app.put("/api/artifacts/:id", upload.single("model"), (req, res, next) => {
  try {
    const artifacts = mergeArtifactsWithModels().map(({ modelUrl, ...artifact }) => artifact);
    const index = artifacts.findIndex((item) => item.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ message: "文物不存在" });
      return;
    }

    const current = artifacts[index];
    const mergedBody = {
      emissiveIntensity: req.body.emissiveIntensity ?? current.emissiveIntensity,
      modelScale: req.body.modelScale ?? current.modelScale,
      posX: req.body.posX ?? current.posX,
      posY: req.body.posY ?? current.posY,
      posZ: req.body.posZ ?? current.posZ,
      bgColor: req.body.bgColor ?? current.bgColor,
      envLightIntensity: req.body.envLightIntensity ?? current.envLightIntensity,
      extraLightColor: req.body.extraLightColor ?? current.extraLightColor,
      extraLightIntensity: req.body.extraLightIntensity ?? current.extraLightIntensity,
      extraLightX: req.body.extraLightX ?? current.extraLightX,
      extraLightY: req.body.extraLightY ?? current.extraLightY,
      extraLightZ: req.body.extraLightZ ?? current.extraLightZ,
    };
    const modelSettings = normalizeModelSettings(mergedBody);
    const envSettings = normalizeEnvironmentSettings(mergedBody);
    let modelFile = current.modelFile || "";
    let source = current.source || "metadata";

    if (req.file) {
      deleteModelFile(current.modelFile);
      modelFile = req.file.filename;
      source = "upload";
    }

    artifacts[index] = {
      ...current,
      name: (req.body.name ?? current.name).trim(),
      description: (req.body.description ?? current.description).trim(),
      era: (req.body.era ?? current.era).trim(),
      category: (req.body.category ?? current.category).trim(),
      origin: (req.body.origin ?? current.origin).trim(),
      material: (req.body.material ?? current.material).trim(),
      dimensions: (req.body.dimensions ?? current.dimensions).trim(),
      emissiveIntensity: modelSettings.emissiveIntensity,
      modelScale: modelSettings.modelScale,
      posX: modelSettings.posX,
      posY: modelSettings.posY,
      posZ: modelSettings.posZ,
      bgColor: envSettings.bgColor,
      envLightIntensity: envSettings.envLightIntensity,
      extraLightColor: envSettings.extraLightColor,
      extraLightIntensity: envSettings.extraLightIntensity,
      extraLightX: envSettings.extraLightX,
      extraLightY: envSettings.extraLightY,
      extraLightZ: envSettings.extraLightZ,
      modelFile,
      source,
      updatedAt: new Date().toISOString(),
    };

    writeArtifacts(artifacts);
    res.json({ success: true, artifact: mergeArtifactsWithModels().find((item) => item.id === req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/artifacts/:id", (req, res) => {
  const artifacts = mergeArtifactsWithModels().map(({ modelUrl, ...artifact }) => artifact);
  const artifact = artifacts.find((item) => item.id === req.params.id);
  if (!artifact) {
    res.status(404).json({ message: "文物不存在" });
    return;
  }

  deleteModelFile(artifact.modelFile);
  writeArtifacts(artifacts.filter((item) => item.id !== req.params.id));
  res.json({ success: true });
});

app.use("/models", express.static(modelsDir));
app.use(express.static(projectRoot));

// Express 5 no longer accepts "*" as a path pattern.
// Use a regex to serve the SPA entry for any remaining GET request.
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(projectRoot, "index.html"));
});

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    message: error.message || "服务器发生错误",
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`数字文物展馆已启动: http://localhost:${port}`);
});
