import fs from "fs";
import path from "path";

const [, , fileA, fileB] = process.argv;

if (!fileA || !fileB) {
  console.error("Kullanım: node compare-asins.js <dosya1.txt> <dosya2.txt>");
  process.exit(1);
}

function loadAsins(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Dosya bulunamadı: ${filePath}`);
    process.exit(1);
  }
  return new Set(
    fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim().toUpperCase())
      .filter((l) => /^[A-Z0-9]{10}$/.test(l))
  );
}

const setA = loadAsins(fileA);
const setB = loadAsins(fileB);

const common = [...setA].filter((a) => setB.has(a));
const onlyA = [...setA].filter((a) => !setB.has(a));
const onlyB = [...setB].filter((b) => !setA.has(b));

console.log("\n📊 Sonuçlar:");
console.log(`  📁 ${path.basename(fileA)}: ${setA.size} ASIN`);
console.log(`  📁 ${path.basename(fileB)}: ${setB.size} ASIN`);
console.log(`  ✅ Ortak: ${common.length}`);
console.log(`  🔵 Sadece ${path.basename(fileA)}: ${onlyA.length}`);
console.log(`  🟡 Sadece ${path.basename(fileB)}: ${onlyB.length}`);

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = `compare-result_${ts}.md`;

let md = `# ASIN Karşılaştırma\n\n`;
md += `| | Dosya | ASIN Sayısı |\n`;
md += `|--|:------|------------:|\n`;
md += `| 📁 | \`${path.basename(fileA)}\` | ${setA.size} |\n`;
md += `| 📁 | \`${path.basename(fileB)}\` | ${setB.size} |\n`;
md += `| ✅ | Ortak | ${common.length} |\n`;
md += `| 🔵 | Sadece \`${path.basename(fileA)}\` | ${onlyA.length} |\n`;
md += `| 🟡 | Sadece \`${path.basename(fileB)}\` | ${onlyB.length} |\n\n`;
md += `---\n\n`;

if (common.length > 0) {
  md += `## ✅ Ortak ASIN'ler (${common.length})\n\n`;
  md += common.map((a) => `- \`${a}\``).join("\n");
  md += `\n\n---\n\n`;
}

if (onlyA.length > 0) {
  md += `## 🔵 Sadece \`${path.basename(fileA)}\` (${onlyA.length})\n\n`;
  md += onlyA.map((a) => `- \`${a}\``).join("\n");
  md += `\n\n---\n\n`;
}

if (onlyB.length > 0) {
  md += `## 🟡 Sadece \`${path.basename(fileB)}\` (${onlyB.length})\n\n`;
  md += onlyB.map((a) => `- \`${a}\``).join("\n");
  md += `\n`;
}

fs.writeFileSync(outFile, md, "utf8");
console.log(`\n📄 Rapor: ${outFile}\n`);
