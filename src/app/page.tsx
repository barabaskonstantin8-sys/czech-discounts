// src/app/page.tsx
// Комментарии на русском, код на английском.

"use client";

import { useEffect, useMemo, useState } from "react";
import Fuse from "fuse.js";

// RU: тип одной акции
type Offer = {
  id: string;
  chain: string;          // RU: сеть: Albert/Lidl/Billa/Penny/Kaufland
  title: string;          // RU: название товара
  price: number;          // RU: новая цена
  oldPrice?: number;      // RU: старая цена (если есть)
  discount?: number;      // RU: % скидки (если есть)
  validFrom: string;      // RU: с какой даты (YYYY-MM-DD)
  validTo: string;        // RU: по какую дату (YYYY-MM-DD)
  cities?: string[];      // RU: города (необязательно)
  labels?: string[];      // RU: ключевые слова для поиска
  url?: string;           // RU: ссылка на листовку/источник
};

export default function Home() {
  // RU: состояния фильтров и данных
  const [offers, setOffers] = useState<Offer[]>([]);
  const [q, setQ] = useState("");
  const [chain, setChain] = useState<string>("All");
  const [city, setCity] = useState<string>("All");
  const [onlyActual, setOnlyActual] = useState(true);
  const [sort, setSort] = useState<"discount" | "price" | "validTo">("discount");

  // RU: грузим JSON со скидками из /public/data/offers.json
  useEffect(() => {
    const load = async () => {
      const res = await fetch("/data/offers.json", { cache: "no-store" });
      const data = (await res.json()) as Offer[];
      setOffers(data);
    };
    load();
  }, []);

  // RU: значения для выпадающих списков
  const chains = useMemo(() => ["All", ...new Set(offers.map(o => o.chain))], [offers]);
  const cities = useMemo(() => {
    const set = new Set<string>();
    offers.forEach(o => o.cities?.forEach(c => set.add(c)));
    return ["All", ...Array.from(set)];
  }, [offers]);

  // RU: поиск по названию и меткам
  const fuse = useMemo(
    () =>
      new Fuse(offers, {
        keys: ["title", "labels"],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [offers]
  );

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // RU: применяем поиск, фильтры, сортировку
  const view = useMemo(() => {
    let list: Offer[] = q.trim() ? fuse.search(q).map(r => r.item) : [...offers];

    if (chain !== "All") list = list.filter(o => o.chain === chain);
    if (city !== "All") list = list.filter(o => (o.cities || []).includes(city));
    if (onlyActual) list = list.filter(o => o.validTo >= today);

    list.sort((a, b) => {
      if (sort === "discount") return (b.discount ?? 0) - (a.discount ?? 0);
      if (sort === "price") return a.price - b.price;
      return a.validTo.localeCompare(b.validTo);
    });

    return list;
  }, [q, chain, city, onlyActual, sort, offers, fuse, today]);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-3xl font-bold mb-2">Slevy Česko — агрегатор скидок</h1>
      <p className="text-sm text-gray-600 mb-6">
        Vyhledávač akcí v supermarketech: Albert, Lidl, Billa, Penny, Kaufland.
      </p>

      {/* RU: панель фильтров */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-6">
        <input
          className="border rounded-xl p-3 md:col-span-2"
          placeholder="Поиск: maslo, pivo, mléko…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        <select className="border rounded-xl p-3" value={chain} onChange={e => setChain(e.target.value)}>
          {chains.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <select className="border rounded-xl p-3" value={city} onChange={e => setCity(e.target.value)}>
          {cities.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <select className="border rounded-xl p-3" value={sort} onChange={e => setSort(e.target.value as any)}>
          <option value="discount">Сначала большая скидка</option>
          <option value="price">Сначала дешевле</option>
          <option value="validTo">Скоро заканчивается</option>
        </select>
      </div>

      <label className="inline-flex items-center gap-2 mb-6">
        <input type="checkbox" checked={onlyActual} onChange={(e) => setOnlyActual(e.target.checked)} />
        <span>Показывать только актуальные акции</span>
      </label>

      {/* RU: карточки товаров */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {view.map(o => (
          <article key={o.id} className="border rounded-2xl p-4 shadow-sm">
            <div className="text-xs text-gray-500 mb-1">{o.chain}</div>
            <h3 className="font-semibold text-lg mb-2">{o.title}</h3>
            <div className="flex items-baseline gap-3 mb-2">
              <span className="text-2xl font-bold">{o.price.toFixed(2)} Kč</span>
              {typeof o.oldPrice === "number" && (
                <span className="line-through text-gray-400">{o.oldPrice.toFixed(2)} Kč</span>
              )}
              {typeof o.discount === "number" && (
                <span className="ml-auto text-sm bg-green-100 text-green-700 px-2 py-1 rounded-xl">
                  -{o.discount}%
                </span>
              )}
            </div>
            <div className="text-sm text-gray-600 mb-2">
              Действительно: {o.validFrom} → {o.validTo}
            </div>
            {o.cities?.length ? (
              <div className="text-xs text-gray-500 mb-2">Города: {o.cities.join(", ")}</div>
            ) : null}
            {o.url && (
              <a href={o.url} target="_blank" className="text-blue-600 text-sm underline">
                Открыть листовку / источник
              </a>
            )}
          </article>
        ))}
      </div>

      {view.length === 0 && (
        <div className="text-center text-gray-500 mt-10">
          Ничего не найдено. Попробуй другой запрос или сними фильтры.
        </div>
      )}

      <footer className="text-xs text-gray-400 mt-10">
        MVP • данные демонстрационные • редактируй <code>/public/data/offers.json</code>
      </footer>
    </main>
  );
}