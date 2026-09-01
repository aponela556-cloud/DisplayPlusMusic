export type LrclibRecord = {
    id?: number;
    name?: string;
    trackName?: string;
    artistName?: string;
    albumName?: string;
    duration?: number;
    instrumental?: boolean;
    plainLyrics?: string | null;
    syncedLyrics?: string | null;
};

export type LrclibTrackMetadata = {
    title: string;
    artist: string;
    album: string;
    durationSeconds: number;
};

export type ScoredLrclibRecord = {
    record: LrclibRecord;
    score: number;
    titleScore: number;
    artistScore: number;
    durationDifference: number | null;
};

const VERSION_WORDS = [
    'acoustic',
    'anniversary',
    'bonus',
    'deluxe',
    'demo',
    'edit',
    'extended',
    'feat',
    'featuring',
    'from',
    'instrumental',
    'karaoke',
    'live',
    'mix',
    'mono',
    'remaster',
    'remastered',
    'remix',
    'soundtrack',
    'stereo',
    'version',
    'アコースティック',
    'サウンドトラック',
    'ライブ',
    'リマスター',
    '不插電',
    '不插电',
    '伴奏',
    '原聲',
    '原声',
    '現場',
    '现场',
    '重製',
    '重制',
];

const VERSION_PATTERN = VERSION_WORDS.join('|');
const BRACKETED_VERSION = new RegExp(
    `\\s*[([{（［【][^\\])}）］】]*(?:${VERSION_PATTERN})[^\\])}）］】]*[)\\]}）］】]`,
    'giu',
);
const TRAILING_VERSION = new RegExp(
    `\\s*[-–—:]\\s*(?:\\d{4}\\s*)?(?:${VERSION_PATTERN}).*$`,
    'iu',
);

export function normalizeMetadata(value: string | undefined): string {
    return (value ?? '')
        .normalize('NFKD')
        .toLocaleLowerCase()
        .replace(/\p{M}/gu, '')
        .replace(/&/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

export function cleanTrackTitle(title: string): string {
    let cleaned = title.trim();
    let previous = '';
    while (cleaned !== previous) {
        previous = cleaned;
        cleaned = cleaned.replace(BRACKETED_VERSION, '').trim();
    }
    return cleaned.replace(TRAILING_VERSION, '').trim() || title.trim();
}

export function cleanArtistName(artist: string): string {
    const [primaryArtist] = artist.split(/\s+(?:feat(?:uring)?\.?|ft\.?|with)\s+/iu);
    return primaryArtist.trim() || artist.trim();
}

function levenshteinDistance(left: string, right: string): number {
    if (left === right) return 0;
    if (left.length === 0) return right.length;
    if (right.length === 0) return left.length;

    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + substitutionCost,
            );
        }
        previous = current;
    }
    return previous[right.length];
}

function metadataSimilarity(left: string | undefined, right: string | undefined): number {
    const normalizedLeft = normalizeMetadata(left);
    const normalizedRight = normalizeMetadata(right);
    if (!normalizedLeft || !normalizedRight) return 0;
    if (normalizedLeft === normalizedRight) return 1;

    const longestLength = Math.max(normalizedLeft.length, normalizedRight.length);
    const editSimilarity = 1 - (levenshteinDistance(normalizedLeft, normalizedRight) / longestLength);
    const containmentSimilarity = normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)
        ? Math.min(normalizedLeft.length, normalizedRight.length) / longestLength
        : 0;
    return Math.max(editSimilarity, containmentSimilarity);
}

function artistSimilarity(left: string | undefined, right: string | undefined): number {
    const normalizedLeft = normalizeMetadata(left);
    const normalizedRight = normalizeMetadata(right);
    const baseSimilarity = metadataSimilarity(left, right);
    if (!normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight) {
        return baseSimilarity;
    }

    const leftIsPrimary = normalizedRight.startsWith(`${normalizedLeft} `);
    const rightIsPrimary = normalizedLeft.startsWith(`${normalizedRight} `);
    return leftIsPrimary || rightIsPrimary ? Math.max(baseSimilarity, 0.9) : baseSimilarity;
}

function durationScore(recordDuration: number | undefined, expectedDuration: number): {
    score: number;
    difference: number | null;
} {
    if (!recordDuration || expectedDuration <= 0) return { score: 0.5, difference: null };

    const difference = Math.abs(recordDuration - expectedDuration);
    if (difference <= 2) return { score: 1, difference };
    if (difference <= 5) return { score: 0.9, difference };
    if (difference <= 10) return { score: 0.75, difference };
    if (difference <= 20) return { score: 0.5, difference };
    if (difference <= 45) return { score: 0.2, difference };
    return { score: 0, difference };
}

function scoreRecord(record: LrclibRecord, track: LrclibTrackMetadata): ScoredLrclibRecord {
    const recordTitle = record.trackName ?? record.name ?? '';
    const cleanedTitle = cleanTrackTitle(track.title);
    const cleanedRecordTitle = cleanTrackTitle(recordTitle);
    const cleanedArtist = cleanArtistName(track.artist);
    const cleanedRecordArtist = cleanArtistName(record.artistName ?? '');

    const titleScore = Math.max(
        metadataSimilarity(track.title, recordTitle),
        metadataSimilarity(cleanedTitle, cleanedRecordTitle),
    );
    const artistScore = Math.max(
        artistSimilarity(track.artist, record.artistName),
        artistSimilarity(cleanedArtist, cleanedRecordArtist),
    );
    const albumScore = track.album && track.album !== 'None' && record.albumName
        ? metadataSimilarity(track.album, record.albumName)
        : 0.5;
    const duration = durationScore(record.duration, track.durationSeconds);
    const syncedBonus = record.syncedLyrics ? 0.015 : 0;

    return {
        record,
        score: Math.min(1, (
            titleScore * 0.58 +
            artistScore * 0.27 +
            duration.score * 0.12 +
            albumScore * 0.03 +
            syncedBonus
        )),
        titleScore,
        artistScore,
        durationDifference: duration.difference,
    };
}

export function selectBestLyricsMatch(
    records: LrclibRecord[],
    track: LrclibTrackMetadata,
): ScoredLrclibRecord | null {
    const candidates = records
        .filter(record => Boolean(record.syncedLyrics || record.plainLyrics))
        .map(record => scoreRecord(record, track))
        .filter(candidate => (
            candidate.titleScore >= 0.68 &&
            candidate.artistScore >= 0.5 &&
            candidate.score >= 0.72
        ))
        .sort((left, right) => {
            const scoreDifference = right.score - left.score;
            if (Math.abs(scoreDifference) > 0.02) return scoreDifference;
            if (Boolean(left.record.syncedLyrics) !== Boolean(right.record.syncedLyrics)) {
                return left.record.syncedLyrics ? -1 : 1;
            }
            return (left.durationDifference ?? Number.POSITIVE_INFINITY) -
                (right.durationDifference ?? Number.POSITIVE_INFINITY);
        });

    return candidates[0] ?? null;
}
