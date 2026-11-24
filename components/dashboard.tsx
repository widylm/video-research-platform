"use client";

import {
  ChevronRight, CircleUserRound, FlaskConical, Folder, Heart, LogOut, Plus, Search, Users,
} from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { z } from "zod";
import { refreshLibrary, runSearch, signOut, updateLibrary } from "@/app/actions";
import { libraryCommand, type Library, type LibraryCommand } from "@/lib/library";
import type { Profile } from "@/lib/supabase";
import { defaultSearch, sortVideos, type SearchQuery, type Sort, type Video } from "@/lib/videos";
import { AddVideoDialog } from "./add-video-dialog";
import { Brand } from "./brand";
import { CollectorSearch } from "./collector-search";
import { Collections } from "./collections";
import { SearchForm } from "./search-form";
import { VideoDialog } from "./video-dialog";
import { VideoResults } from "./video-results";

const sections = {
  search: { label: "Каталог видео", icon: Search, subtitle: "Демонстрационный каталог: примеры интерфейса, без сбора из соцсетей." },
  pilot: { label: "Сбор роликов", icon: Search, subtitle: "Получайте новые ролики TikTok и Instagram через облачный Fashion Radar." },
  favorites: { label: "Избранное", icon: Heart, subtitle: "Личная подборка видео, которые вы сохранили." },
  collections: { label: "Коллекции", icon: Folder, subtitle: "Собирайте видео по темам и делитесь подборками с командой." },
} as const;
type Section = keyof typeof sections;

const labels = { admin: "Администратор", member: "Участник", viewer: "Наблюдатель" };
const storageKey = "video-research.demo.library.v1";
const librarySchema = z.object({
  favorites: z.array(z.uuid()),
  collections: z.array(z.object({
    id: z.uuid(),
    ownerId: z.literal("demo"),
    name: z.string(),
    shared: z.boolean(),
    videoIds: z.array(z.uuid()),
  })),
});

function toggle(values: string[], id: string, saved: boolean) {
  return saved ? Array.from(new Set([...values, id])) : values.filter((value) => value !== id);
}

function changeDemoLibrary(library: Library, command: LibraryCommand): Library {
  switch (command.kind) {
    case "favorite":
      return { ...library, favorites: toggle(library.favorites, command.videoId, command.saved) };
    case "create":
      return { ...library, collections: [{
        id: crypto.randomUUID(), ownerId: "demo", name: command.name, shared: command.shared, videoIds: [],
      }, ...library.collections] };
    case "delete":
      return { ...library, collections: library.collections.filter(({ id }) => id !== command.collectionId) };
    case "item":
      return { ...library, collections: library.collections.map((collection) => collection.id === command.collectionId
        ? { ...collection, videoIds: toggle(collection.videoIds, command.videoId, command.saved) }
        : collection) };
  }
}

export function Dashboard({ initialVideos, initialLibrary, profile, cloudBrowserSearch }: {
  initialVideos: Video[];
  initialLibrary: Library;
  profile: Profile | null;
  cloudBrowserSearch?: boolean;
}) {
  const [section, setSection] = useState<Section>("search");
  const [draft, setDraft] = useState(defaultSearch);
  const [applied, setApplied] = useState(defaultSearch);
  const [videos, setVideos] = useState(initialVideos);
  const [library, setLibrary] = useState(initialLibrary);
  const [view, setView] = useState<"grid" | "table">("grid");
  const [librarySort, setLibrarySort] = useState<Sort>("recent");
  const [selected, setSelected] = useState<Video | null>(null);
  const [adding, setAdding] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");
  const [collectionId, setCollectionId] = useState<string>();
  const [error, setError] = useState("");
  const [busy, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const sessionBusy = busy || saving;
  const canEdit = profile?.role !== "viewer";
  const activeCollection = library.collections.find(({ id }) => id === collectionId);

  useEffect(() => {
    if (profile) return;
    let saved: z.infer<typeof librarySchema> | undefined;
    try {
      saved = librarySchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? "null")).data;
    } catch {
      // A blocked storage API leaves the demo usable for the current page.
    }
    const videos = Object.fromEntries(initialVideos.map((video) => [video.id, video]));
    setLibrary({ ...(saved ?? initialLibrary), videos });
  }, [initialLibrary, initialVideos, profile]);

  function search(query: SearchQuery, record = true) {
    setError("");
    startTransition(async () => {
      try {
        const result = await runSearch(query, record);
        if ("error" in result) setError(result.error);
        else {
          setApplied(query);
          setVideos(result.data);
        }
      } catch {
        setError("Не удалось выполнить поиск. Попробуйте ещё раз.");
      }
    });
  }

  function reload() {
    if (!profile) return;
    setError("");
    startTransition(async () => {
      try {
        const result = await refreshLibrary();
        if ("error" in result) setError(result.error);
        else setLibrary(result.data);
      } catch {
        setError("Не удалось загрузить коллекции.");
      }
    });
  }

  async function save(input: LibraryCommand): Promise<boolean> {
    setError("");
    const command = libraryCommand.safeParse(input);
    if (!command.success) {
      setError("Проверьте данные для сохранения.");
      return false;
    }

    setSaving(true);
    try {
      if (profile) {
        const result = await updateLibrary(command.data);
        if ("error" in result) {
          setError(result.error);
          return false;
        }
        setLibrary(result.data);
      } else {
        const next = changeDemoLibrary(library, command.data);
        setLibrary(next);
        try {
          localStorage.setItem(storageKey, JSON.stringify({
            favorites: next.favorites, collections: next.collections,
          }));
        } catch {
          setError("Изменение доступно до перезагрузки страницы. Браузер заблокировал хранилище.");
        }
      }
      return true;
    } catch {
      setError("Не удалось сохранить изменение. Попробуйте ещё раз.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function navigate(next: Section) {
    if (next === section) return;
    setSection(next);
    setCollectionId(undefined);
    setError("");
    if (next === "search" && profile) search(applied, false);
    if (next === "favorites" || next === "collections") reload();
  }

  const sorted = section === "search" ? videos : sortVideos(
    (section === "favorites" ? library.favorites : activeCollection?.videoIds ?? [])
      .flatMap((id) => {
        const video = library.videos[id];
        return video ? [video] : [];
      }),
    librarySort,
  );
  const title = activeCollection?.name ?? sections[section].label;

  return <div className="app-shell">
    <aside className="sidebar">
      <Brand />
      <nav aria-label="Разделы" className="main-nav">
        {Object.entries(sections).map(([key, { label, icon: Icon }]) => {
          const destination = key as Section;
          const count = key === "favorites" ? library.favorites.length : undefined;
          return <button className="nav-entry" key={key} aria-current={section === key ? "page" : undefined}
            disabled={sessionBusy} onClick={() => navigate(destination)}>
            <Icon size={19} /><span>{label}</span>
            {count ? <small>{count}</small> : null}
          </button>;
        })}
      </nav>
      <div className="sidebar-account">
        <span className="account-icon">{profile ? <CircleUserRound size={20} /> : <FlaskConical size={19} />}</span>
        <span className="account-details">
          <strong>{profile?.display_name ?? "Демо-профиль"}</strong>
          <small>{profile ? labels[profile.role] : "Данные в этом браузере"}</small>
        </span>
        {profile && <form action={signOut}><button className="icon-button logout" aria-label="Выйти" title="Выйти">
          <LogOut size={17} />
        </button></form>}
      </div>
    </aside>

    <div className="workspace">
      <header className="workspace-bar">
        <div className="breadcrumbs"><span>Рабочее пространство</span><ChevronRight size={15} /><strong>{sections[section].label}</strong></div>
        <span className="mode-badge">{profile ? <Users size={15} /> : <FlaskConical size={15} />}
          {profile ? "Командный доступ" : "Демо-режим"}
        </span>
        {profile && <form action={signOut} className="mobile-logout"><button className="icon-button" aria-label="Выйти"><LogOut size={17} /></button></form>}
      </header>

      <main className="main-content">
        <div className="page-heading">
          <div className="page-title">
            <h1>{title}</h1>
            <p>{activeCollection ? (activeCollection.shared ? "Коллекция для команды" : "Личная коллекция")
              : section === "search" && profile ? "Ищите видео, сохранённые в каталоге команды."
                : sections[section].subtitle}</p>
          </div>
          {profile && canEdit && section !== "pilot" && <button className="button primary" type="button" disabled={sessionBusy}
            onClick={() => setAdding(true)}><Plus size={18} /> Добавить видео</button>}
        </div>

        {section === "search" && <SearchForm
          query={draft} demo={!profile} busy={sessionBusy} onChange={setDraft}
          onSearch={(query) => {
            setDraft(query);
            search(query === defaultSearch ? defaultSearch : { ...query, sort: applied.sort });
          }}
        />}

        {section === "pilot" && <CollectorSearch enabled={!!cloudBrowserSearch} canCollect={!!profile && canEdit} />}

        {section === "collections" && <Collections
          collections={library.collections} active={activeCollection} canEdit={canEdit}
          demo={!profile} busy={sessionBusy}
          canDelete={(collection) => canEdit && (
            collection.ownerId === (profile?.id ?? "demo") || (profile?.role === "admin" && collection.shared)
          )}
          onOpen={(collection) => {
            setError("");
            setCollectionId(collection?.id);
          }}
          onCreate={(name, shared) => save({ kind: "create", name, shared })}
          onDelete={async (collection) => {
            if (window.confirm(`Удалить коллекцию «${collection.name}»?`)
              && await save({ kind: "delete", collectionId: collection.id })) setCollectionId(undefined);
          }}
          onRefresh={reload}
        />}

        {error && !selected && <p className="notice error" role="alert">{error}</p>}
        {section !== "pilot" && (section !== "collections" || activeCollection) && <section className="results-section" aria-label="Видео">
          {section === "search" && <h2>{profile ? "Результаты по каталогу" : "Результаты поиска"}</h2>}
          <VideoResults key={activeCollection?.id ?? section}
            videos={sorted} favorites={library.favorites} view={view}
            sort={section === "search" ? applied.sort : librarySort} busy={sessionBusy}
            emptyHint={section === "search" ? "Измените параметры поиска или сбросьте фильтры."
              : section === "favorites" ? "Нажмите на сердечко в карточке, чтобы сохранить видео."
              : "Откройте карточку видео, чтобы добавить его в эту коллекцию."}
            onView={setView} onSort={(sort) => {
              if (section === "search") search({ ...applied, sort });
              else setLibrarySort(sort);
            }}
            onOpen={(video) => {
              setError("");
              setSaveNotice("");
              setSelected(video);
            }}
            onFavorite={(video) => save({ kind: "favorite", videoId: video.id, saved: !library.favorites.includes(video.id) })}
          />
        </section>}
      </main>
    </div>

    {adding && <AddVideoDialog collections={library.collections} collectionId={collectionId}
      onClose={() => setAdding(false)}
      onSaved={(video, created) => {
        setAdding(false);
        setSaveNotice(created ? "Видео сохранено в каталоге." : "Это видео уже в каталоге. Открыта существующая карточка.");
        setSelected(video);
        search(applied, false);
        reload();
      }}
    />}
    {selected && <VideoDialog key={selected.id}
      video={selected} canEditDetails={Boolean(profile && canEdit && !selected.isMock)}
      collections={library.collections} canEdit={canEdit} busy={sessionBusy} error={error} notice={saveNotice}
      onClose={() => {
        setSelected(null);
        setError("");
      }}
      onUpdated={(video) => {
        setSelected(video);
        setVideos((list) => list.map((entry) => entry.id === video.id ? video : entry));
        setLibrary((current) => current.videos[video.id]
          ? { ...current, videos: { ...current.videos, [video.id]: video } } : current);
        setSaveNotice("Карточка обновлена.");
        if (section === "search") search(applied, false);
      }}
      onToggle={(collection, saved) => save({
        kind: "item", collectionId: collection.id, videoId: selected.id, saved,
      })}
    />}
  </div>;
}
