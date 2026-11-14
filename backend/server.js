const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

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

// 2D 图片生成 3D：只用内存缓存接收单张图片，不落盘
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!imageExtensions.has(ext)) {
      cb(new Error("仅支持 .jpg、.png、.webp、.bmp 图片文件"));
      return;
    }
    cb(null, true);
  },
});

// 本机 2D->3D 推理服务（ai3d/server.py）
const AI3D_URL = process.env.AI3D_URL || "http://127.0.0.1:8765";
const AI3D_DIR = path.join(projectRoot, "ai3d");
const AI3D_SCRIPT = path.join(AI3D_DIR, "server.py");
const AI3D_PYTHON = path.join(AI3D_DIR, "venv", "Scripts", "python.exe");
const AI3D_LOG = path.join(AI3D_DIR, "ai3d-service.log");

// 只记录“由本进程拉起”的子进程；用户自己开着的服务我们不去管，也不会去杀
let ai3dChild = null;
let ai3dStarting = null;

async function probeAi3d(timeoutMs = 2000) {
  try {
    const res = await fetch(`${AI3D_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch (_error) {
    return false;
  }
}

// 拉起 ai3d/server.py：windowsHide 保证不弹黑色终端，日志写入 ai3d/ai3d-service.log
function spawnAi3d() {
  if (ai3dChild && ai3dChild.exitCode === null) return;
  if (!fs.existsSync(AI3D_PYTHON)) {
    throw new Error(
      `未找到 Python 虚拟环境：${AI3D_PYTHON}。请先按开发日志搭建 ai3d/venv 并安装依赖。`
    );
  }

  const logFd = fs.openSync(AI3D_LOG, "a");
  fs.writeSync(logFd, `\n===== ${new Date().toISOString()} 启动推理服务 =====\n`);

  const child = spawn(AI3D_PYTHON, [AI3D_SCRIPT], {
    cwd: AI3D_DIR,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      // 让 Python 自己盯着父进程，父进程被强杀时也跟着退出，避免残留占显存
      AI3D_PARENT_PID: String(process.pid),
    },
  });
  ai3dChild = child;

  child.on("error", (error) => {
    fs.appendFileSync(AI3D_LOG, `[spawn error] ${error.message}\n`);
    if (ai3dChild === child) ai3dChild = null;
  });
  child.on("exit", (code) => {
    fs.appendFileSync(AI3D_LOG, `[exit] code=${code}\n`);
    if (ai3dChild === child) ai3dChild = null;
  });
}

// 结束由本进程拉起的推理服务（整个进程树，Windows 用 taskkill）
function stopAi3d() {
  const child = ai3dChild;
  if (!child || child.exitCode !== null) {
    ai3dChild = null;
    return;
  }
  ai3dChild = null;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch (_error) {
    // 退出阶段忽略失败，父进程消失后 Python 的看门狗也会自行退出
  }
}

// 确保推理服务在跑：已在运行则直接返回，否则拉起并轮询 /health
function ensureAi3d(timeoutMs = 120000) {
  if (ai3dStarting) return ai3dStarting;

  ai3dStarting = (async () => {
    if (await probeAi3d()) return true;

    spawnAi3d();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (await probeAi3d()) return true;
      if (!ai3dChild) {
        throw new Error("AI 推理服务进程已退出，详情见 ai3d/ai3d-service.log");
      }
    }
    throw new Error("AI 推理服务启动超时，详情见 ai3d/ai3d-service.log");
  })().finally(() => {
    ai3dStarting = null;
  });

  return ai3dStarting;
}

// 应用退出时带走推理服务
["exit", "SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].forEach((signal) => {
  process.on(signal, () => {
    stopAi3d();
    if (signal !== "exit") process.exit(0);
  });
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
    bgColor: normalizeHexColor(source.bgColor, "#545454"),
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

// 2D 图片 -> 3D 模型：转发给本机 ai3d/server.py，成功后登记到展品列表
app.post("/api/generate-3d", uploadImage.single("image"), async (req, res) => {
  const baseName = (req.body.name || "").trim() || (req.file?.originalname || "").replace(/\.(jpe?g|png|webp|bmp)$/i, "") || "AI生成文物";

  try {
    // 推理服务未运行时自动拉起（隐藏窗口），无需用户手动点 启动推理服务.bat
    try {
      await ensureAi3d();
    } catch (error) {
      res.status(503).json({ message: `无法启动 2D->3D 推理服务：${error.message}` });
      return;
    }

    const base64 = Buffer.from(req.file.buffer).toString("base64");
    const genRes = await fetch(`${AI3D_URL}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: base64,
        num_inference_steps: Number(req.body.numInferenceSteps) || 30,
        octree_resolution: Number(req.body.octreeResolution) || 256,
        with_texture: req.body.withTexture === "true",
      }),
      signal: AbortSignal.timeout(900000), // 推理较慢，最多等 15 分钟
    });

    const genJson = await genRes.json().catch(() => null);
    if (!genRes.ok || !genJson?.modelFile) {
      res.status(genRes.status || 500).json({
        message: `2D->3D 生成失败：${genJson?.detail || genJson?.message || "未知错误"}`,
      });
      return;
    }

    // glb 已由 ai3d 服务直接写入 models/，这里只登记展品
    const existing = { name: baseName };
    const artifact = createDefaultArtifactFromModel(genJson.modelFile, existing);
    artifact.name = baseName;
    artifact.source = "ai-generated";
    artifact.createdAt = new Date().toISOString();
    artifact.updatedAt = new Date().toISOString();

    const artifacts = mergeArtifactsWithModels().map(({ modelUrl, ...a }) => a);
    artifacts.push({
      ...artifact,
      modelFile: genJson.modelFile,
    });
    writeArtifacts(artifacts);
    res.status(201).json({
      success: true,
      artifact: mergeArtifactsWithModels().find((item) => item.id === artifact.id),
      warning: genJson.warning || null,
    });
  } catch (error) {
    res.status(500).json({ message: `2D->3D 接口错误：${error.message}` });
  }
});

// 前端点“图片生成3D”时先预热推理服务：后台拉起，不阻塞用户选图
app.post("/api/ai3d/ensure", async (_req, res) => {
  try {
    await ensureAi3d();
    res.json({ success: true, running: true });
  } catch (error) {
    res.status(503).json({ success: false, message: error.message });
  }
});

app.get("/api/ai3d/status", async (_req, res) => {
  res.json({
    running: await probeAi3d(),
    managed: Boolean(ai3dChild && ai3dChild.exitCode === null),
  });
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

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`数字文物展馆已启动: http://localhost:${port}`);
});

// 供 Electron 桌面端复用：可直接加载本模块启动服务
module.exports = { app, server, port, ensureAi3d, stopAi3d };
