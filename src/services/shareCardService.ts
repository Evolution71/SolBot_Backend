import { createCanvas } from "@napi-rs/canvas";
import { TradeSummary } from "./tradeService";

const WIDTH = 1080;
const HEIGHT = 1080;

/**
 * Renders a PNG "share card" purely from real trade data — no scripted
 * numbers, no fabricated PNL. If the marketing plan calls for a screenshot
 * showing a win, the win has to have actually happened; this function just
 * makes an actual result look good, it doesn't invent one.
 */
export function renderShareCard(params: {
  handle: string | null;
  summary: TradeSummary;
  realizedPnlSol: number;
  botUsername: string;
}): Buffer {
  const { handle, summary, realizedPnlSol, botUsername } = params;
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // Background
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, "#0B0E14");
  gradient.addColorStop(1, "#121623");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Faint grid
  ctx.strokeStyle = "rgba(124,255,178,0.06)";
  ctx.lineWidth = 1;
  for (let x = 0; x < WIDTH; x += 54) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y < HEIGHT; y += 54) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y);
    ctx.stroke();
  }

  // Reticle ring, echoing the dashboard's signature motif
  ctx.strokeStyle = "rgba(124,255,178,0.25)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(WIDTH / 2, 340, 170, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(WIDTH / 2, 340, 120, 0, Math.PI * 2);
  ctx.stroke();

  const pnlColor = realizedPnlSol >= 0 ? "#7CFFB2" : "#FF6B6B";
  const pnlSign = realizedPnlSol >= 0 ? "+" : "";

  ctx.fillStyle = pnlColor;
  ctx.font = "700 72px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${pnlSign}${realizedPnlSol.toFixed(3)}`, WIDTH / 2, 360);

  ctx.fillStyle = "#8B93A7";
  ctx.font = "500 28px sans-serif";
  ctx.fillText("REALIZED SOL PNL", WIDTH / 2, 410);

  // Handle
  ctx.fillStyle = "#E7EAF0";
  ctx.font = "600 44px sans-serif";
  ctx.fillText(handle ? `@${handle}` : "Anonymous Sniper", WIDTH / 2, 540);

  // Stats row
  const stats = [
    { label: "TRADES", value: String(summary.totalTrades) },
    { label: "SOL BOUGHT", value: summary.solBought.toFixed(2) },
    { label: "SOL SOLD", value: summary.solSold.toFixed(2) },
  ];
  const colWidth = WIDTH / stats.length;
  stats.forEach((s, i) => {
    const cx = colWidth * i + colWidth / 2;
    ctx.fillStyle = "#E7EAF0";
    ctx.font = "700 40px sans-serif";
    ctx.fillText(s.value, cx, 660);
    ctx.fillStyle = "#8B93A7";
    ctx.font = "500 22px sans-serif";
    ctx.fillText(s.label, cx, 700);
  });

  // Watermark
  ctx.fillStyle = "#5B8CFF";
  ctx.font = "700 34px sans-serif";
  ctx.fillText(`Traded on @${botUsername}`, WIDTH / 2, HEIGHT - 90);

  ctx.fillStyle = "#8B93A7";
  ctx.font = "400 20px sans-serif";
  ctx.fillText("Non-custodial · Real trades only", WIDTH / 2, HEIGHT - 55);

  return canvas.toBuffer("image/png");
}
