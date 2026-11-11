import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { analyzeDocuments } from "./ai.mjs";

try { process.loadEnvFile(path.resolve(".env")); } catch (error) { if (error.code !== "ENOENT") throw error; }

const paths = process.argv.slice(2);
if (!paths.length) throw new Error("請提供至少一個檔案路徑。");

const files = await Promise.all(paths.map(async filePath => ({
  name: path.basename(filePath),
  base64: (await readFile(filePath)).toString("base64")
})));

const analysis = await analyzeDocuments({
  text: "這些檔案屬於同一案件。請交叉比對並產出完整的可執行性評估與內部決策簡報方案。",
  files
});

if (process.env.ANALYSIS_OUTPUT_PATH) {
  await writeFile(process.env.ANALYSIS_OUTPUT_PATH, JSON.stringify(analysis, null, 2));
}

console.log(JSON.stringify({
  verdict: analysis.decision.verdict,
  confidence: analysis.decision.confidence,
  counts: {
    hardConditions: analysis.hardConditions.length,
    bidChecklist: analysis.bidChecklist.length,
    clarifications: analysis.clarifications.length,
    complianceMatrix: analysis.complianceMatrix.length,
    developmentItems: analysis.developmentItems.length,
    milestones: analysis.milestones.length,
    riskRegister: analysis.riskRegister.length,
    decisionItems: analysis.decisionItems.length,
    proposalOutline: analysis.proposalOutline.length,
    presentationPlan: analysis.presentationPlan.length
  },
  slideTitles: analysis.presentationPlan.map(item => item.title),
  outputPath: process.env.ANALYSIS_OUTPUT_PATH || null
}, null, 2));
