"use client";

import { ArrowLeft, Folder, FolderPlus, LockKeyhole, RefreshCw, Trash2, Users } from "lucide-react";
import type { Collection } from "@/lib/library";

export function Collections({ collections, active, canEdit, canDelete, busy, demo, onOpen, onCreate, onDelete, onRefresh }: {
  collections: Collection[];
  active: Collection | undefined;
  canEdit: boolean;
  canDelete: (collection: Collection) => boolean;
  busy: boolean;
  demo: boolean;
  onOpen: (collection: Collection | undefined) => void;
  onCreate: (name: string, shared: boolean) => Promise<boolean>;
  onDelete: (collection: Collection) => void;
  onRefresh: () => void;
}) {
  if (active) return <div className="collection-controls">
    <button className="button secondary" onClick={() => onOpen(undefined)}>
      <ArrowLeft size={17} /> Все коллекции
    </button>
    {canDelete(active) && <button className="button danger" disabled={busy} onClick={() => onDelete(active)}>
      <Trash2 size={17} /> Удалить коллекцию
    </button>}
  </div>;

  return <>
    {canEdit && <form className="panel collection-form" onSubmit={async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      if (await onCreate(String(data.get("name") ?? ""), data.get("shared") === "on")) form.reset();
    }}>
      <h2 className="form-title"><FolderPlus size={20} /> Новая коллекция</h2>
      <div className="collection-form-fields">
        <label>Название<input name="name" placeholder="Например, идеи для осенней кампании" required maxLength={80} /></label>
        <label className="checkbox-label"><input name="shared" type="checkbox" defaultChecked /> Видна команде</label>
        <button className="button primary" disabled={busy}><FolderPlus size={17} /> Создать</button>
      </div>
    </form>}
    <div className="collection-controls collection-list-heading">
      <h2>Все коллекции</h2>
      {!demo && <button className="button secondary" disabled={busy} onClick={onRefresh}>
        <RefreshCw size={16} /> Обновить
      </button>}
    </div>
    {collections.length ? <div className="collection-grid">
      {collections.map((collection) => <button key={collection.id} className="panel collection-card"
        onClick={() => onOpen(collection)}>
        <span className="collection-icon"><Folder size={21} /></span>
        <strong>{collection.name}</strong>
        <span className="collection-card-details">
          <span>{collection.videoIds.length} видео</span>
          <span>{collection.shared ? <Users size={15} /> : <LockKeyhole size={14} />}
            {collection.shared ? "Командная" : "Личная"}</span>
        </span>
      </button>)}
    </div> : <div className="panel empty-state">
      <Folder size={26} /><strong>Коллекций пока нет</strong>
      <p>{canEdit ? "Создайте коллекцию, чтобы собирать видео по теме." : "Здесь появятся коллекции, открытые для команды."}</p>
    </div>}
  </>;
}
