// Consecutive exchanges between slots share a row until something on the main conversation separates them.
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, ChevronRight, CircleX, ClipboardCheck, LoaderCircle, SquareTerminal } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { AgentLogo, clock, ROOM, slotHash } from "./common";
import { json, type Block, type BoardData, type SlotData } from "./data";
import { Carried } from "./media";
import { Words } from "./write";
import { Fold, foldOf, folded, MARKDOWN, Running, SaidOf, type Shown, type Step } from "./tools";

type Tool = Extract<Block, { kind: "tool" }>;
type User = Extract<Block, { kind: "user" }>;
type Answer = Extract<Block, { kind: "assistant" }>;
type Item =
  | Exclude<Shown, { kind: "user" }>
  | { kind: "in"; at: string; message: User }
  | { kind: "out"; at: string; tool: Tool }
  | { kind: "task" | "notice"; at: string; time: number | null; text: string };
export type Exchange = { kind: "exchange"; at: string; groups: Item[][]; live: boolean };
export type Row = Exchange | { kind: "main"; at: string; block: Shown } | { kind: "sent"; at: string; send: NonNullable<Tool["send"]> };

function source(b: Shown) {
  return b.kind === "fold" ? b.steps[0]! : b.kind === "running" ? b.tool : b;
}

export function exchanges(blocks: Block[], running: boolean): Row[] {
  const rows: Row[] = [];
  const group = (items: Item[], live = false) => {
    if (!items.length) return;
    const last = rows.at(-1);
    if (last?.kind === "exchange") {
      last.groups.push(items);
      last.live = live;
    } else rows.push({ kind: "exchange", at: items[0]!.at, groups: [items], live });
  };
  const turns: Shown[][] = [];
  for (const b of folded(blocks)) {
    if (!turns.length || source(b).begins) turns.push([]);
    turns.at(-1)!.push(b);
  }
  for (const turn of turns) {
    const begin = source(turn[0]!).begins;
    const cut = begin && !begin.yours ? turn.findIndex((b) => b.kind === "user" && b.queued && !b.sender) : 0;
    const inner = turn.slice(0, cut < 0 ? turn.length : cut);
    const items: Item[] = [];
    const sent: Extract<Row, { kind: "sent" }>[] = [];
    const lastCall = inner.findLastIndex((b) => b.kind === "running" || (b.kind === "fold" && b.steps.some((s) => s.kind === "tool")));
    let steps: Step[] = [];
    const flush = () => {
      if (steps.length) items.push(foldOf(steps));
      steps = [];
    };
    for (const [i, b] of inner.entries()) {
      if (b.kind === "fold") {
        for (let s of b.steps) {
          if (s.kind === "tool" && s.send?.media) {
            sent.push({ kind: "sent", at: s.at + ":sent", send: s.send });
            s = { ...s, send: undefined };
          }
          if (s.kind === "tool" && s.out) {
            if (!s.out.only || !s.result || s.result.error) steps.push(s);
            flush();
            items.push({ kind: "out", at: s.at + ":out", tool: s });
          } else steps.push(s);
        }
      } else if (b.kind === "assistant" && i < lastCall) steps.push(b);
      else {
        flush();
        if (b.kind === "user") {
          items.push(b.sender ? { kind: "in", at: b.at, message: b } : { kind: "notice", at: b.at, time: b.time, text: b.text });
        } else if (b.kind === "system" && b.begins?.by === "task") items.push({ kind: "task", at: b.at, time: b.time, text: b.title });
        else if (b.kind === "running") {
          items.push(b);
          if (b.tool.send?.media) sent.push({ kind: "sent", at: b.at + ":sent", send: b.tool.send });
          if (b.tool.out) items.push({ kind: "out", at: b.at + ":out", tool: b.tool });
        } else {
          const prev = items.at(-1);
          if (prev?.kind === "assistant" && b.kind === "assistant") {
            prev.text += "\n\n" + b.text;
            prev.time = b.time;
            if (b.local) prev.local = { images: { ...prev.local?.images, ...b.local.images }, links: { ...prev.local?.links, ...b.local.links } };
          } else items.push({ ...b });
        }
      }
    }
    flush();
    group(items, cut < 0 && turn === turns.at(-1) && running);
    rows.push(...sent);
    const after: Item[] = [];
    for (const b of cut < 0 ? [] : turn.slice(cut)) {
      if (b.kind === "user" && b.queued && b.sender) after.push({ kind: "in", at: b.at, message: b });
      else rows.push({ kind: "main", at: b.at, block: b });
      for (const s of b.kind === "fold" ? b.steps : b.kind === "running" ? [b.tool] : []) {
        if (s.kind === "tool" && s.out) after.push({ kind: "out", at: s.at + ":out", tool: s });
      }
    }
    group(after);
  }
  return rows;
}

const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.replace(/^\s*(?:#+|>|[-*+]|\d+\.)\s+/, "").replace(/\*\*|__|`/g, "").trim();

export function summary(row: Exchange, draft = "") {
  const items = row.groups.flat();
  const refs = [...new Set(items.flatMap((i) => i.kind === "in" ? [i.message.sender!.slot] : i.kind === "out" ? [i.tool.out!.to] : []))];
  const outgoing = refs.length > 0 && !items.some((i) => i.kind === "in");
  const last = items.findLast((i) => ["assistant", "in", "out", "task", "notice"].includes(i.kind));
  const tail = items.at(-1);
  const error = tail?.kind === "system" && (tail.title === "API 报错" || tail.title === "你打断了回合");
  const failed = error || (last?.kind === "out" && !!last.tool.result?.error);
  const refKind = items.some((i) => i.kind === "task") ? "后台任务" : "Rhodium";
  const current = row.groups.at(-1)!;
  const active = row.live && current.findLast((i) => i.kind === "running");
  const time = last?.kind === "in" ? last.message.time : last?.kind === "out" ? last.tool.time : last && "time" in last ? last.time : null;
  const text = last?.kind === "in" ? last.message.text : last?.kind === "out" ? last.tool.out!.text : last && "text" in last ? last.text : "";
  const said = current.flatMap((i): Answer[] => i.kind === "assistant" ? [i] : i.kind === "fold" ? i.steps.filter((s): s is Answer => s.kind === "assistant") : []).at(-1);
  const doing = active ? ["正在跑", active.tool.shown.name, active.tool.shown.arg].filter(Boolean).join(" ") : row.live ? draft || said?.text : undefined;
  return { refs, outgoing, refKind, failed, time, way: last?.kind, text: firstLine(doing || text), doing: !!doing };
}

type Peer = { ref: string; name: string; id?: string; agent?: SlotData["agent"] };

export function Avatar({ peer, size }: { peer: Peer; size: number }) {
  return <span style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground ring-1 ring-background">
    {peer.agent ? <AgentLogo agent={peer.agent} className="size-[60%]" /> : peer.ref.split("/").at(-1)?.[0]}
  </span>;
}

function PeerName({ peer }: { peer: Peer }) {
  return peer.id ? <a className="min-w-0 truncate hover:underline" href={slotHash(peer.id, location.hash.slice(1), matchMedia(ROOM).matches)}>{peer.name}</a> : <span className="truncate">{peer.name}</span>;
}

const failure = <CircleX aria-label="出错" className="inline size-3.5 shrink-0 text-destructive" />;

function Detail({ item, self, peer, conversation }: { item: Item; self: Peer; peer: (ref: string) => Peer; conversation: string }) {
  if (item.kind === "fold") return <Fold f={item} conversation={conversation} />;
  if (item.kind === "running") return <Running tool={item.tool} />;
  if (item.kind === "assistant") return <SaidOf value={{ local: item.local, conversation }}><Streamdown mode="static" {...MARKDOWN}>{item.text}</Streamdown></SaidOf>;
  if (item.kind === "system") return <p className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">{item.title}</p>;
  if (item.kind === "task" || item.kind === "notice") return <div className="grid gap-1 text-xs text-muted-foreground">
    <div className="flex items-center gap-2">{item.kind === "task" ? <SquareTerminal aria-label="后台任务" className="size-[18px]" /> : <img src="./favicon-64.png" alt="Rhodium" className="size-[18px]" />}{item.time !== null && clock(item.time)}</div>
    {item.kind === "notice" && <Words text={item.text} />}
  </div>;
  if (item.kind !== "in" && item.kind !== "out") return null;
  const incoming = item.kind === "in";
  const other = peer(incoming ? item.message.sender!.slot : item.tool.out!.to);
  const time = incoming ? item.message.time : item.tool.time;
  return <div className="grid gap-1 text-[13px] text-muted-foreground">
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      {!incoming && <><Avatar peer={self} size={18} /><span className="hidden @min-[40rem]:contents"><PeerName peer={self} /></span><ArrowRight className="size-3" aria-label="发给" /></>}
      <Avatar peer={other} size={18} /><PeerName peer={other} />
      {incoming && item.message.sender?.report && <ClipboardCheck className="size-3.5" aria-label="汇报" />}
      {time !== null && <span className="shrink-0 tabular-nums">{clock(time)}</span>}
      {!incoming && item.tool.result?.error && failure}
    </div>
    <div className="@min-[40rem]:pl-6"><Words text={incoming ? item.message.text : item.tool.out!.text} />
      {incoming && item.message.media && <Carried media={item.message.media} />}
    </div>
  </div>;
}

export function usePeer(slot: SlotData) {
  const { data } = useQuery({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board") });
  const cards = data?.workspaces.flatMap((w) => [...Object.values(w.groups).flat(), ...w.archived]);
  return (ref: string): Peer => {
    const card = ref === slot.ref ? slot : cards?.find((c) => c.ref === ref);
    const [ws, name] = ref.split("/");
    return { ref, name: name && ws === slot.ref.split("/")[0] ? name : ref, id: card?.id, agent: card?.agent };
  };
}

export function ExchangeLine({ row, slot, conversation, drafts }: { row: Exchange; slot: SlotData; conversation: string; drafts: { text: string; whole: boolean }[] }) {
  const peer = usePeer(slot);
  const self = peer(slot.ref);
  const line = summary(row, drafts.at(-1)?.text);
  const peers = line.refs.map(peer);
  const name = peers.map((p) => p.name).join("、") || line.refKind;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const top = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = button.current;
    const log = el?.closest("[role=log]");
    if (!el || !log || top.current === null) return;
    const section = el.parentElement!;
    const previous = top.current;
    top.current = null;
    const target = log.scrollTop + el.getBoundingClientRect().top - previous;
    // Collapsing the very last exchange can leave too little content to scroll the button back.
    const column = section.parentElement!;
    const below = () => column.getBoundingClientRect().bottom - log.getBoundingClientRect().bottom;
    let space = Math.max(0, Math.ceil(target - log.scrollTop - below()));
    if (space) section.style.paddingBottom = space + "px";
    log.scrollTop = target;
    if (!space) return;
    const release = () => {
      const used = Math.max(0, Math.ceil(space - below()));
      if (used >= space) return;
      space = used;
      section.style.paddingBottom = space ? space + "px" : "";
    };
    log.addEventListener("scroll", release);
    const observer = new ResizeObserver(release);
    observer.observe(column);
    return () => {
      log.removeEventListener("scroll", release);
      observer.disconnect();
      section.style.paddingBottom = "";
    };
  }, [open]);
  return <section data-tick-at={row.at} className="@container grid min-w-0 grid-cols-1 gap-2">
    <button ref={button} type="button" aria-expanded={open} aria-label={`和 ${name} 的往来`} onClick={() => {
      if (open) top.current = button.current!.getBoundingClientRect().top;
      setOpen(!open);
    }} className="flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border border-running/20 bg-running/5 px-2 text-left text-sm hover:bg-running/10 dark:border-running/30 dark:bg-running/10">
      <span className="flex min-w-0 shrink items-center overflow-hidden">
        {line.outgoing && <><Avatar peer={self} size={22} /><ArrowRight aria-label="发给" className="mx-1 size-3 shrink-0 text-muted-foreground" /></>}
        {peers.length ? <span className="flex -space-x-1">{peers.map((p) => <Avatar key={p.ref} peer={p} size={22} />)}</span> :
          line.refKind === "后台任务" ? <SquareTerminal className="size-[22px]" aria-label="后台任务" /> : <img alt="Rhodium" className="size-[22px]" src="./favicon-64.png" />}
      </span>
      <span className="hidden max-w-[45%] truncate font-medium @min-[40rem]:block">{name}</span>
      <span className="relative min-w-0 flex-1">
        <span className={cn("block truncate", open && "invisible", line.way === "assistant" ? "text-foreground/80" : "text-muted-foreground", line.doing && "live-shine")}>
          {!line.doing && line.way === "in" && <ArrowDownLeft className="mr-1 inline size-3.5" aria-label="收到" />}
          {!line.doing && line.way === "out" && !line.outgoing && <ArrowUpRight className="mr-1 inline size-3.5" aria-label="发出" />}
          {line.text}
        </span>
        {open && <span className="absolute inset-0 truncate font-medium @min-[40rem]:hidden">{name}</span>}
      </span>
      {line.failed && failure}
      {(row.live || line.time !== null) && <span className={cn("w-11 shrink-0 justify-end text-xs text-muted-foreground tabular-nums", row.live ? "flex" : "hidden @min-[40rem]:flex")}>
        {row.live ? <LoaderCircle className="size-3.5 animate-spin text-running" aria-label="正在跑" /> : clock(line.time!)}
      </span>}
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
    </button>
    {open && <div className="ml-2 grid gap-5 border-l py-1 pl-3">
      {row.groups.map((group) => <div key={group[0]!.at} className="grid min-w-0 grid-cols-1 gap-2">
        {group.map((item) => <Detail key={item.at} item={item} self={self} peer={peer} conversation={conversation} />)}
      </div>)}
      {row.live && drafts.map((draft, i) => <Streamdown key={i} {...MARKDOWN} isAnimating={!draft.whole}>{draft.text}</Streamdown>)}
    </div>}
  </section>;
}
