import React, { useEffect, useRef, useState } from "react";
import { tr } from "../shared/i18n";
import type { ShopConfig } from "../server/domain";
import type { Theme } from "../shared/presentation";
import { useApi } from "./api";
import { PreviewSurface, type PreviewScreen } from "./ScreenGallery";
import { createRequestId } from "./request-id";

type Proposal = { status: "none" | "generating" | "ready" | "failed"; startedAt?: number; theme?: Theme; error?: string };
type Snapshot = { base: number; source: ShopConfig | null; config: ShopConfig };
const homeScreen: PreviewScreen = { id: "about", get name() { return tr("お店のこと"); }, get description() { return tr("お店の紹介"); }, pane: "about" };
const pollMs = 15000;

/** The shop opens with the built-in design while its own AI design is made; this offers it once ready. */
export function ThemeProposalNotice({ shopId, reload, onStatusChange }: { shopId: string; reload: () => Promise<unknown>; onStatusChange?: (status: Proposal["status"]) => void }) {
  const api = useApi();
  const [proposal, setProposal] = useState<Proposal>({ status: "none" });
  const [review, setReview] = useState<{ before: ShopConfig; after: ShopConfig; snapshot: Snapshot }>();
  const [busy, setBusy] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const requestId = useRef(createRequestId());
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api<Proposal>(`/api/shops/${shopId}/theme-proposal`);
        if (!alive) return;
        setProposal(next);
        if (next.status === "generating") timer = setTimeout(() => void poll(), pollMs);
      } catch { if (alive) timer = setTimeout(() => void poll(), pollMs); }
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [shopId, api, pollKey]);
  useEffect(() => { if (review) dialog.current?.showModal(); }, [review]);
  useEffect(() => { onStatusChange?.(proposal.status); }, [proposal.status, onStatusChange]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const open = () => act(async () => {
    const snapshot = await api<Snapshot>(`/api/shops/${shopId}/local-editor`);
    const before = snapshot.config;
    const after = { ...before, appearance: { accent: "sage" as const, layout: "standard" as const, imageUrl: "", ...before.appearance, theme: proposal.theme! } };
    setReview({ before, after, snapshot });
  });
  const apply = () => act(async () => {
    const { snapshot, after } = review!;
    // The same release path as other design changes: only the theme is taken from this proposal.
    const plan = await api<{ id: string }>(`/api/shops/${shopId}/plan`, {
      text: tr("AIが作成したお店専用のデザインを反映"), config: after,
      local: { base: snapshot.base, source: snapshot.source, requestId: requestId.current, scope: { kind: "theme" } },
    });
    await api(`/api/shops/${shopId}/plans/${plan.id}/approve`, {});
    await api(`/api/shops/${shopId}/plans/${plan.id}/publish`, {});
    await api(`/api/shops/${shopId}/theme-proposal/applied`, {});
    dialog.current?.close(); setReview(undefined); setProposal({ status: "none" });
    await reload();
  });
  const dismiss = () => act(async () => {
    await api(`/api/shops/${shopId}/theme-proposal/dismiss`, {});
    dialog.current?.close(); setReview(undefined); setProposal({ status: "none" });
  });
  const retry = () => act(async () => { setProposal(await api<Proposal>(`/api/shops/${shopId}/theme-proposal/retry`, {})); setPollKey(value => value + 1); });
  if (proposal.status === "none") return null;
  return <section className="panel theme-proposal-notice" aria-label={tr("お店専用のデザイン")} data-status={proposal.status}>
    {proposal.status === "generating" && <p role="status"><span className="theme-proposal-spinner" aria-hidden="true" />{tr("AIがお店専用のデザインを作っています。数分かかることがあります。それまでは標準のデザインで表示し、できあがったらここでお知らせします。")}</p>}
    {proposal.status === "ready" && <>
      <p><b>{tr("AIがお店専用のデザインを作りました。")}</b>{tr("今のデザインと見比べて、使うかどうか選べます。")}</p>
      <div className="actions"><button type="button" className="primary" disabled={busy} onClick={() => void open()}>{tr("デザインを確認する")}</button><button type="button" disabled={busy} onClick={() => void dismiss()}>{tr("今のデザインのままにする")}</button></div>
    </>}
    {proposal.status === "failed" && <>
      <p>{tr("お店専用のデザインを作成できませんでした。標準のデザインのまま使えます。")}</p>
      <div className="actions"><button type="button" disabled={busy} onClick={() => void retry()}>{tr("もう一度作成する")}</button><button type="button" className="text-button" disabled={busy} onClick={() => void dismiss()}>{tr("閉じる")}</button></div>
    </>}
    {error && !review && <p className="alert" role="alert">{error}</p>}
    {review && <dialog ref={dialog} className="visual-change-review theme-proposal-review" aria-labelledby="theme-proposal-heading" onCancel={event => { event.preventDefault(); if (!busy) { dialog.current?.close(); setReview(undefined); } }}>
      <h2 id="theme-proposal-heading">{tr("お店専用のデザインを確認")}</h2>
      <p>{tr("今のデザインとAIが作ったデザインを見比べてください。「このデザインにする」を押すと、見た目だけが入れ替わります。メニュー・料金・予約の設定は変わりません。")}</p>
      <div className="conflict-columns">
        <section aria-label={tr("今のデザイン")}><h3>{tr("今のデザイン")}</h3><PreviewSurface config={review.before} shopId={shopId} screen={homeScreen} /></section>
        <section aria-label={tr("AIが作ったデザイン")}><h3>{tr("AIが作ったデザイン")}</h3><PreviewSurface config={review.after} shopId={shopId} screen={homeScreen} /></section>
      </div>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="actions visual-review-actions">
        <button type="button" disabled={busy} onClick={() => { dialog.current?.close(); setReview(undefined); }}>{tr("あとで決める")}</button>
        <button type="button" disabled={busy} onClick={() => void dismiss()}>{tr("今のデザインのままにする")}</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void apply()}>{busy ? tr("反映しています…") : tr("このデザインにする")}</button>
      </div>
    </dialog>}
  </section>;
}
