import React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ParentFrame, parentShop, parentDocuments, type ParentShop } from "./ParentFrame";

// The public parent finder (site/), with fixture shops. Cloud answers are fixed and no Firebase project is
// contacted; on-device questions use this browser's Gemini Nano when Chrome provides it.
const shops: ParentShop[] = [
  parentShop("akari", "炉端 灯", { area: "東京都新宿区", cuisine: "和食・炉端焼き", pageUrl: "https://akari.example/reserve", networkUrl: "https://akari.example/agent/reservation_concierge", networkTool: "akari_reservation_concierge" }),
  parentShop("sole", "トラットリア ソーレ", { area: "東京都渋谷区", cuisine: "イタリアン・イタリア料理", pageUrl: "https://sole.example/reserve", networkUrl: "https://sole.example/agent/reservation_concierge", networkTool: "sole_reservation_concierge" }),
  parentShop("komado", "文具と器 こまど", { area: "東京都台東区", cuisine: "雑貨・生活雑貨", pageUrl: "https://komado.example/", reservationEnabled: false }),
  parentShop("num05", "Num05", { area: "神奈川県横浜市港北区・大倉山公園", cuisine: "ネイル・美容サービス", pageUrl: "https://nail.example/", reservationEnabled: false }),
];
// An address makes the page load the embedded Google map, so only the map story has one.
const withAddress = shops.map(shop => shop.id === "num05" ? { ...shop, address: "〒222-0037 神奈川県横浜市港北区大倉山２丁目１０" } : shop);

const meta = {
  id: "parent-finder",
  title: "お店さがし/トップページ",
  component: ParentFrame,
  parameters: { layout: "fullscreen" },
  args: { label: "お店さがし" },
  render: args => <ParentFrame key={JSON.stringify(args.scenario)} {...args} />,
} satisfies Meta<typeof ParentFrame>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Shops: Story = { name: "登録店あり", args: { scenario: { page: "site", shops } } };
export const Empty: Story = { name: "登録店なし", args: { scenario: { page: "site" } } };
export const Map: Story = { name: "地図でお店を確認", args: { scenario: { page: "site", shops: withAddress } } };
export const OwnKey: Story = { name: "自分のAPIキーを使う", args: { scenario: { page: "site", shops, ai: "byok" } } };
export const DocumentAnswer: Story = { name: "公開資料から地域の情報を回答", args: { scenario: { page: "site", documents: parentDocuments, open: "document-answer" } } };
export const VoiceGuide: Story = { name: "地域の案内を音声で相談", args: { scenario: { page: "site", documents: parentDocuments, voice: true } } };
export const VoiceShop: Story = { name: "話し相手を店舗に切り替える", args: { scenario: { page: "site", documents: parentDocuments, voice: true, shops: [parentShop("voice-demo", "音声相談のサンプル店", { area: "東京", cuisine: "雑貨", pageUrl: "https://voice-demo.example/", networkUrl: "https://voice-demo.example/agent/guide", reservationEnabled: false })] } } };
