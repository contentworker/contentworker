import { createContext, type ReactNode, useContext } from 'react';

/**
 * Surfaces that ship ahead of their server side. `assistant` (the assistant's column and its ⌘J
 * toggle) stays off: it has no server side yet. `approvals` (the Approvals inbox) is on. Set per
 * tree with <FeaturesProvider> (tests, previews).
 */
export interface Features {
  readonly assistant: boolean;
  readonly approvals: boolean;
}

export const DEFAULT_FEATURES: Features = {
  assistant: false,
  approvals: true,
};

const Ctx = createContext<Features>(DEFAULT_FEATURES);

export function FeaturesProvider(props: { value: Partial<Features>; children: ReactNode }) {
  return (
    <Ctx.Provider value={{ ...DEFAULT_FEATURES, ...props.value }}>{props.children}</Ctx.Provider>
  );
}

export const useFeatures = () => useContext(Ctx);
