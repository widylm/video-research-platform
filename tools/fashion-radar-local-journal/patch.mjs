export const originalSave = `const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resultFile=path.join(root,'.tmp','results.json');
async function saveResults(){
  if(!['done','empty'].includes(collector.state.phase))return;
  await mkdir(path.dirname(resultFile),{recursive:true});
  await writeFile(resultFile+'.next',JSON.stringify(collector.state),'utf8');
  await rename(resultFile+'.next',resultFile);
}`;

export const originalCollect = `if(url.pathname==='/api/collect'){
  if(collector.busy||!['waiting','done','empty'].includes(collector.state.phase))throw Error('Сначала открой поиск и дождись страницы.');
  const run=collector.collect();
  run.then(saveResults).catch(()=>{});
  send(res,202,{ok:true});return;
}`;

const collectorImport = "import { createLocalCollectorJournal } from './kadr-journal/collector.mjs';";
const journalInit = "const kadrLocalJournal=createLocalCollectorJournal(root,saveResults);";
const patchedSave = originalSave.replace("saveResults(){", "saveResults(state=collector.state){")
  .replace("includes(collector.state.phase)", "includes(state.phase)").replace("JSON.stringify(collector.state)", "JSON.stringify(state)")
  + `\n${journalInit}`;
const patchedCollect = originalCollect.replace("run.then(saveResults).catch(()=>{});", "kadrLocalJournal.track(collector,run);");

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function replaceBlock(source, original, updated, label) {
  const pattern = new RegExp(`^([ \\t]*)${original.split("\n").map(escape).join("\\r?\\n\\1")}(?=\\r?$)`, "gm");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Ожидался ровно один фрагмент ${label} из Issue №15. Файл не изменён.`);
  }
  return source.replace(pattern, (match, indent) => updated.split("\n").map((line) => indent + line)
    .join(match.includes("\r\n") ? "\r\n" : "\n"));
}

export function patchCollector(source) {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const save = replaceBlock(source.slice(bom.length), originalSave, patchedSave, "saveResults");
  const patched = replaceBlock(save, originalCollect, patchedCollect, "/api/collect");
  const newline = patched.includes("\r\n") ? "\r\n" : "\n";
  const shebang = patched.match(/^#![^\r\n]*\r?\n/)?.[0] ?? "";
  return `${bom}${shebang}${collectorImport}${newline}${patched.slice(shebang.length)}`;
}
