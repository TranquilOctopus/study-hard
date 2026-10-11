// Spaced repetition via FSRS (the algorithm modern Anki uses), through ts-fsrs.

import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type Grade } from "ts-fsrs";
import type { Schedule } from "./model";

export interface Settings {
  newPerDay: number;
  reviewsPerDay: number;
  /** Desired retention, 0.7 - 0.99. */
  retention: number;
  /** Hour of the day (local time) at which a new study day begins. */
  dayStartHour: number;
}

export const DEFAULT_SETTINGS: Settings = { newPerDay: 20, reviewsPerDay: 200, retention: 0.9, dayStartHour: 4 };

const SETTINGS_KEY = "study-hard:settings";

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Storage may be unavailable (private mode); settings then last for the session.
  }
}

export const GRADES: { rating: Grade; label: string; key: string }[] = [
  { rating: Rating.Again, label: "Again", key: "1" },
  { rating: Rating.Hard, label: "Hard", key: "2" },
  { rating: Rating.Good, label: "Good", key: "3" },
  { rating: Rating.Easy, label: "Easy", key: "4" },
];

function toCard(s: Schedule): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsedDays,
    scheduled_days: s.scheduledDays,
    learning_steps: s.learningSteps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    last_review: s.lastReview === undefined ? undefined : new Date(s.lastReview),
  };
}

function fromCard(c: Card): Schedule {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    lastReview: c.last_review?.getTime(),
  };
}

export function newSchedule(now = new Date()): Schedule {
  return fromCard(createEmptyCard(now));
}

function scheduler(settings: Settings) {
  return fsrs(generatorParameters({ enable_fuzz: true, request_retention: settings.retention }));
}

export function answer(s: Schedule, rating: Grade, settings: Settings, now = new Date()): Schedule {
  return fromCard(scheduler(settings).next(toCard(s), now, rating).card);
}

/** Due date for each grade, for the labels on the answer buttons. */
export function preview(s: Schedule, settings: Settings, now = new Date()): Map<Grade, number> {
  const out = scheduler(settings).repeat(toCard(s), now);
  return new Map(GRADES.map(({ rating }) => [rating, out[rating].card.due.getTime()]));
}

export function formatInterval(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const hours = min / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days / 30).toFixed(1).replace(/\.0$/, "")}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

/** Start of the current study day (local time, honouring dayStartHour). */
export function dayStart(settings: Settings, now = new Date()): number {
  const d = new Date(now);
  if (d.getHours() < settings.dayStartHour) d.setDate(d.getDate() - 1);
  d.setHours(settings.dayStartHour, 0, 0, 0);
  return d.getTime();
}
