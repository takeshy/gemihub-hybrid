import { tr } from "../shared/i18n";
import React, { useEffect, useState } from "react";
import type { ThemeProposal } from "../shared/theme-proposal";
import { useApi } from "./api";
import type { Plan } from "./App";
import { ScreenGallery } from "./ScreenGallery";
import { FunctionalOverview } from "./FunctionalOverview";
export function InitialPlanReview({shopId,plan,busy,onBack,onAccept}:{shopId:string;plan:Plan;busy:boolean;onBack:()=>void;onAccept:(themeStartedAt?: number)=>void}) {
  const api = useApi();
  const deferred = plan.themeProposal && !plan.config.appearance?.theme;
  const [proposal, setProposal] = useState<ThemeProposal>();
  const [pollKey, setPollKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/shops/${shopId}/theme-proposal`;
  const planQuery = `?plan=${encodeURIComponent(plan.id)}`;
  useEffect(() => {
    if (!deferred) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api<ThemeProposal>(endpoint + planQuery);
        if (!active) return;
        setProposal(next);
        setError("");
        if (next.status !== "generating") return;
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [api, endpoint, planQuery, deferred, pollKey]);
  async function retry() {
    setRetrying(true);
    setError("");
    try {
      setProposal(await api<ThemeProposal>(endpoint + "/retry" + planQuery, {}));
      setPollKey(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRetrying(false); }
  }
  const ready = proposal?.status === "ready" && proposal.theme && proposal.startedAt !== undefined ? proposal : undefined;
  const config = ready ? {
    ...plan.config,
    appearance: { accent: "sage" as const, layout: "standard" as const, imageUrl: "", ...plan.config.appearance, theme: ready.theme },
  } : plan.config;
  const themePlaceholder = deferred && !ready ? <div className="notice" data-theme-status={proposal?.status ?? "loading"}>
    {error && <p role="alert">{error}</p>}
    <p role="status">{proposal?.status === "failed" ? tr("お店専用のデザインを作成できませんでした。標準のデザインのまま使えます。") :
      proposal?.status === "none" ? tr("この画面案のデザインは利用できません。") :
        <><span className="theme-proposal-spinner" aria-hidden="true" />{tr("お店専用のデザインを作成中です。完成すると、この画面に表示されます。")}</>}</p>
    {proposal?.status === "failed" && <button type="button" disabled={busy || retrying} onClick={() => void retry()}>{tr("もう一度作成する")}</button>}
  </div> : undefined;
  return <section className="request-review" aria-label={tr("下記の画面でいいですか？")}><span className="pill">{tr("まだお客様には公開されません")}</span><h3>{tr("下記の画面でいいですか？")}</h3><p>{tr("まずは、お店のページでできることを確認しましょう。")}</p>
    <ScreenGallery config={config} shopId={shopId} themePlaceholder={themePlaceholder}/>
    {plan.themeReview?.rendered && <p className="small muted">{tr("修正後のPC・スマートフォンの画面をAIで確認しました。")}</p>}
    <FunctionalOverview config={plan.config}/>
    <p>{tr("用意するページや機能を変更したい場合は、「聞き取りに戻る」から希望を伝えてください。")}</p>
    <aside className="initial-design-guidance">
      <h4>{tr("仮公開したあとにできること")}</h4>
      <p>{tr("仮公開したあと「AIとお店をつくる」を開くと、実際の画面を見ながらAIに指示して見た目を修正できます。")}</p>
      <p>{tr("「このボタンを大きく」「背景を明るく」などの指示で修正できます。")}</p>
      <p>{tr("各種設定は、仮公開後にそれぞれの設定メニューで行えます。")}</p>
    </aside>
    <p>{tr("仮公開中は、このページを用意したGoogleアカウントでログインした本人だけが見られます。")}</p>
    <div className="actions"><button className="text-button" disabled={busy} onClick={onBack}>{tr("聞き取りに戻る")}</button><button className="primary" disabled={busy || retrying} onClick={() => onAccept(ready?.startedAt)}>{busy ? tr("確認しています…") : themePlaceholder ? tr("標準デザインで仮公開する") : tr("仮公開する")}</button></div>
  </section>;
}
