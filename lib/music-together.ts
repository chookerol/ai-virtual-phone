import { loadCharacters } from "./character-storage";
import {
    addChatContact,
    createOrGetSession,
    loadChatMessages,
    pushChatMessage,
    type ChatMessage,
} from "./chat-storage";
import { requestBackgroundChatReply } from "./follow-up-service";
import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";
import { saveMemoryEntry } from "./memory-storage";
import { resolveUserIdentity } from "./settings-storage";
import type { MusicTrack } from "./music-storage";

const ACTIVE_TOGETHER_KEY = "ai_phone_music_together_active_v1";
registerKvMigration(ACTIVE_TOGETHER_KEY);

export type MusicTogetherTrack = Pick<MusicTrack, "id" | "title" | "artist">;

export type MusicTogetherSession = {
    id: string;
    characterId: string;
    startedAt: string;
    listenedSeconds: number;
    tracks: MusicTogetherTrack[];
    lastFeedbackAt?: string;
    latestFeedback?: string;
};

export function loadActiveMusicTogetherSession(): MusicTogetherSession | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = kvGet(ACTIVE_TOGETHER_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as MusicTogetherSession;
        if (!parsed?.id || !parsed.characterId || !parsed.startedAt) return null;
        return {
            ...parsed,
            listenedSeconds: Math.max(0, Number(parsed.listenedSeconds) || 0),
            tracks: Array.isArray(parsed.tracks) ? parsed.tracks.slice(0, 80) : [],
        };
    } catch {
        return null;
    }
}

export function saveActiveMusicTogetherSession(session: MusicTogetherSession | null): void {
    if (typeof window === "undefined") return;
    if (!session) {
        kvRemove(ACTIVE_TOGETHER_KEY);
        return;
    }
    kvSet(ACTIVE_TOGETHER_KEY, JSON.stringify(session));
}

export function createMusicTogetherSession(characterId: string, track?: MusicTrack | null): MusicTogetherSession {
    const now = new Date().toISOString();
    const session: MusicTogetherSession = {
        id: `music_together_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        startedAt: now,
        listenedSeconds: 0,
        tracks: track ? [{ id: track.id, title: track.title, artist: track.artist }] : [],
    };
    saveActiveMusicTogetherSession(session);
    return session;
}

export function appendTogetherTrack(session: MusicTogetherSession, track: MusicTrack): MusicTogetherSession {
    const last = session.tracks[session.tracks.length - 1];
    if (last?.id === track.id) return session;
    const next = {
        ...session,
        tracks: [...session.tracks, { id: track.id, title: track.title, artist: track.artist }].slice(-80),
    };
    saveActiveMusicTogetherSession(next);
    return next;
}

function emitChatUpdated(sessionId: string): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
    }
}

export function recordMusicTogetherTrackChange(together: MusicTogetherSession, track: MusicTrack): void {
    if (!loadCharacters().some(character => character.id === together.characterId)) return;
    addChatContact(together.characterId);
    const session = createOrGetSession(together.characterId);
    pushChatMessage({
        sessionId: session.id,
        role: "system",
        content: `【一起听状态】共同播放已切换为「${track.title}」— ${track.artist || "未知歌手"}。这是正在发生的共享音乐状态，不必每次主动回复，但之后聊天时要知道我们正在一起听这首歌。`,
        mediaData: { appHistoryRole: "user" } as ChatMessage["mediaData"],
    });
    emitChatUpdated(session.id);
}

export async function requestMusicTogetherFeedback(
    together: MusicTogetherSession,
    track: MusicTrack,
    reason: "joined" | "track_changed" | "asked",
): Promise<string | null> {
    if (!loadCharacters().some(character => character.id === together.characterId)) return null;
    addChatContact(together.characterId);
    const session = createOrGetSession(together.characterId);
    const reasonText = reason === "joined"
        ? "我们刚刚进入了一起听房间"
        : reason === "track_changed"
            ? "一起听刚切到了一首新歌"
            : "我想听听你此刻的感受";
    const event = pushChatMessage({
        sessionId: session.id,
        role: "system",
        content: `【一起听｜刚刚】${reasonText}，现在共同播放「${track.title}」— ${track.artist || "未知歌手"}。请像正在和我一起听一样，自然说一两句此刻的反应；不要解释系统或功能。`,
        mediaData: { appHistoryRole: "user" } as ChatMessage["mediaData"],
    });
    emitChatUpdated(session.id);
    const result = await requestBackgroundChatReply(session.id);
    if (!result.ok) return null;
    const reply = loadChatMessages(session.id)
        .filter(message => message.role === "assistant" && message.createdAt >= event.createdAt && message.content.trim())
        .pop();
    emitChatUpdated(session.id);
    return reply?.content.trim() || null;
}

export async function finishMusicTogetherSession(session: MusicTogetherSession): Promise<void> {
    saveActiveMusicTogetherSession(null);
    if (session.listenedSeconds < 60 || session.tracks.length === 0) return;

    const character = loadCharacters().find(item => item.id === session.characterId);
    if (!character) return;
    const user = resolveUserIdentity(session.characterId, "music");
    const names = session.tracks
        .slice(-8)
        .map(track => `《${track.title}》${track.artist ? `（${track.artist}）` : ""}`);
    const extra = session.tracks.length > 8 ? `等，共 ${session.tracks.length} 首歌` : "";
    const minutes = Math.max(1, Math.round(session.listenedSeconds / 60));
    const now = new Date().toISOString();
    const content = `${character.name}和${user?.name || "用户"}进行了一次一起听，共听了约 ${minutes} 分钟，听过${names.join("、")}${extra ? `，${extra}` : ""}。这是一段两人共同经历的音乐时光。`;

    await saveMemoryEntry({
        id: `mem_${session.id}`,
        characterId: session.characterId,
        sourceApp: "music",
        type: "long_term",
        content,
        importance: Math.min(0.9, 0.64 + Math.min(minutes, 60) / 240),
        createdAt: now,
        updatedAt: now,
        metadata: {
            origin: "music_together",
            togetherSessionId: session.id,
            listenedSeconds: session.listenedSeconds,
            trackCount: session.tracks.length,
        },
    });
}
