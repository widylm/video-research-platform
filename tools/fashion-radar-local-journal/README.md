# Локальный журнал Fashion Radar для Windows

Комплект предназначен для версии Fashion Radar с двумя фрагментами `collector/server.mjs` из Issue №15. На компьютере нужен Node.js 22.12 или новее. Готовый `collector.mjs` уже включает зависимости, поэтому `npm install` и правки исходников в папке Fashion Radar не требуются.

## Установка

1. Остановите Fashion Radar и распакуйте архив в отдельную папку.
2. Откройте PowerShell в папке распакованного архива. Подставьте путь к папке, где находится ваш `Start-Collector.cmd`.

   ```powershell
   .\Install-Local-Journal.cmd 'C:\Путь\к\Fashion Radar' --enable
   ```

3. После сообщения «Локальный журнал включён» запустите обычный `Start-Collector.cmd` и проведите один обычный сбор. Файл журнала появится в `.kadr-journal\completed` внутри папки Fashion Radar. Исходный `.tmp\results.json` по-прежнему обновляется.

Установщик сверяет оба фрагмента перед записью и сохраняет точную копию `collector\server.mjs.kadr-original`. Если фрагменты отличаются или файл менялся после установки, скрипт остановится. В таком случае для адаптации нужны `collector/server.mjs` и, если сохранение вынесено отдельно, его модуль записи. Секреты и профиль браузера не нужны.

Запуск с `--check` проверяет совместимость. Без `--enable` первая установка оставляет журнал выключенным. Для выключения используйте `--disable`, затем перезапустите Fashion Radar. Для возврата исходного `server.mjs` используйте `--restore` при остановленном приложении. Оба режима сохраняют журналы и резервную копию.

## Что записывается

Есть отдельная запись для каждого успешно завершённого запуска, включая выдачу из нуля роликов. Остановка или отмена браузерного сбора сохраняет прежнее поведение `.tmp\results.json`, но нового файла журнала не создаёт. Содержимое журнала состоит из метаданных по контракту импорта «Кадра». Комплект выполняет только локальную запись. Для будущей передачи нужно отдельно согласовать разрешённые источники, права хранения и подключение приёмника. [Условия и подключение](https://github.com/widylm/video-research-platform/blob/main/docs/fashion-radar-sync.md)

При недоступности папки `completed` запись остаётся в `.kadr-journal\pending`, а если основной промежуточный каталог недоступен — в `.tmp\kadr-journal-recovery`. Когда обе папки промежуточной записи заблокированы, сборщик пытается сохранить исходное состояние отдельно для каждого запуска в `.tmp\.kadr-rescue-*.json`. Эти файлы восстановления содержат те же данные, что `results.json`, и не попадают в очередь отправки. Не удаляйте их и промежуточные папки до восстановления. После устранения ошибки перезапустите Fashion Radar. Ожидающие записи будут сохранены локально с теми же идентификаторами. Ошибка журналирования отображается в текущем статусе и логе. Старое сохранение `results.json` выполняется отдельно. При полном отказе записи на диск сохранение невозможно.

Используйте локальную папку на NTFS с правом записи. Журнал не зависит от 16 пакетов очереди отправки и растёт, пока записи хранятся на диске. Отдельного сетевого процесса в комплекте нет.

## Изменения в `collector/server.mjs`

Установщик добавляет один импорт и меняет только указанные строки. Фрагменты показаны с отступами из Issue №15, установщик сохраняет дополнительный отступ в файле.

```diff
+import { createLocalCollectorJournal } from './kadr-journal/collector.mjs';
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const resultFile=path.join(root,'.tmp','results.json');
-async function saveResults(){
-  if(!['done','empty'].includes(collector.state.phase))return;
+async function saveResults(state=collector.state){
+  if(!['done','empty'].includes(state.phase))return;
   await mkdir(path.dirname(resultFile),{recursive:true});
-  await writeFile(resultFile+'.next',JSON.stringify(collector.state),'utf8');
+  await writeFile(resultFile+'.next',JSON.stringify(state),'utf8');
   await rename(resultFile+'.next',resultFile);
 }
+const kadrLocalJournal=createLocalCollectorJournal(root,saveResults);
 if(url.pathname==='/api/collect'){
   if(collector.busy||!['waiting','done','empty'].includes(collector.state.phase))throw Error('Сначала открой поиск и дождись страницы.');
   const run=collector.collect();
-  run.then(saveResults).catch(()=>{});
+  kadrLocalJournal.track(collector,run);
   send(res,202,{ok:true});return;
 }
```

## Сборка комплекта из репозитория «Кадра»

```powershell
npm ci
npm run package:fashion-radar-local -- .\installer-output
node --test tests/e2e/fashion-radar-local-journal.test.mjs
```
