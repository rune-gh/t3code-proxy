import { create } from 'zustand';

export type LoginTransitionPhase = 'idle' | 'revealing';

export interface LoginTransitionTimings {
  successHold: number;
  /** Minimum time the auto-login status stays up, measured from page open */
  splashMin: number;
  exit: number;
  reveal: number;
}

export const LOGIN_TRANSITION_TIMINGS: LoginTransitionTimings = {
  successHold: 200,
  splashMin: 0,
  exit: 120,
  reveal: 160,
};

export const LOGIN_TRANSITION_TIMINGS_REDUCED: LoginTransitionTimings = {
  successHold: 150,
  splashMin: 0,
  exit: 60,
  reveal: 80,
};

export const getLoginTransitionTimings = (reducedMotion: boolean): LoginTransitionTimings =>
  reducedMotion ? LOGIN_TRANSITION_TIMINGS_REDUCED : LOGIN_TRANSITION_TIMINGS;

interface LoginTransitionState {
  phase: LoginTransitionPhase;
  /** Incremented on every reveal so the veil can tell rounds apart */
  revealId: number;
  startReveal: () => void;
  finishReveal: () => void;
}

export const useLoginTransitionStore = create<LoginTransitionState>((set) => ({
  phase: 'idle',
  revealId: 0,
  startReveal: () => set((state) => ({ phase: 'revealing', revealId: state.revealId + 1 })),
  finishReveal: () => set({ phase: 'idle' }),
}));

export const isArrivingFromLogin = () => useLoginTransitionStore.getState().phase === 'revealing';
