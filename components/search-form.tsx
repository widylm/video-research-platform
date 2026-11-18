"use client";

import { Hash, RotateCcw, Search, SlidersHorizontal } from "lucide-react";
import { defaultSearch, platformNames, type SearchQuery } from "@/lib/videos";

interface SearchFormProps {
  query: SearchQuery;
  busy: boolean;
  onChange: (query: SearchQuery) => void;
  onSearch: (query: SearchQuery) => void;
}

const sources = { all: "Все платформы", ...platformNames } as const;

export function SearchForm({ query, busy, onChange, onSearch }: SearchFormProps) {
  function field<Key extends keyof SearchQuery>(key: Key, value: SearchQuery[Key]) {
    onChange({ ...query, [key]: value });
  }

  return <form className="panel search-panel" onSubmit={(event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onSearch({
      ...query,
      limit: Number(values.get("limit") || defaultSearch.limit),
      minViews: Number(values.get("minViews") || 0),
      minLikes: Number(values.get("minLikes") || 0),
    });
  }}>
    <div className="search-panel-inner">
      <h2 className="form-title"><SlidersHorizontal size={19} /> Параметры поиска</h2>
      <div className="source-picker" role="group" aria-label="Платформа">
        {Object.entries(sources).map(([key, label]) => {
          const platform = key as SearchQuery["platform"];
          return <button
            key={key} type="button" aria-pressed={query.platform === platform}
            className="source-button" onClick={() => field("platform", platform)}
          >
            {platform !== "all" && <span className="source-dot" aria-hidden="true" />}
            {label}
          </button>;
        })}
      </div>
      <div className="text-fields">
        <label>Ключевые слова
          <span className="with-icon"><Search size={17} /><input
            value={query.keywords} onChange={(event) => field("keywords", event.target.value)}
            placeholder="Например, утренний кофе" maxLength={200}
          /></span>
        </label>
        <label>Хэштеги
          <span className="with-icon"><Hash size={17} /><input
            value={query.hashtags} onChange={(event) => field("hashtags", event.target.value)}
            placeholder="Например, кофе, лайфстайл" maxLength={200}
          /></span>
        </label>
      </div>
      <div className="range-fields">
        <label>Дата публикации с<input
          aria-label="Дата публикации с" type="date" value={query.from}
          onChange={(event) => field("from", event.target.value)}
        /></label>
        <label>Дата публикации по<input
          aria-label="Дата публикации по" type="date" value={query.to}
          onChange={(event) => field("to", event.target.value)}
        /></label>
        <label>Макс. видео<input key={query.limit} name="limit" type="number"
          min={1} max={100} step={1} defaultValue={query.limit} /></label>
        <label>Мин. просмотров<input key={query.minViews} name="minViews" type="number"
          min={0} max={Number.MAX_SAFE_INTEGER} step={1} defaultValue={query.minViews} /></label>
        <label>Мин. лайков<input key={query.minLikes} name="minLikes" type="number"
          min={0} max={Number.MAX_SAFE_INTEGER} step={1} defaultValue={query.minLikes} /></label>
      </div>
    </div>
    <div className="search-footer">
      <span>Источник данных — демонстрационный каталог</span>
      <div className="form-actions">
        <button type="button" className="button quiet" disabled={busy} onClick={(event) => {
          event.currentTarget.form?.reset();
          onSearch(defaultSearch);
        }}>
          <RotateCcw size={16} /> Сбросить
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          <Search size={17} /> {busy ? "Ищем…" : "Найти видео"}
        </button>
      </div>
    </div>
  </form>;
}
