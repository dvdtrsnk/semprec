/* eslint-disable react-refresh/only-export-components -- the provider and its context hook are one cohesive authenticated boundary. */
import { createContext, useContext, type ReactNode } from "react";
import type { AuthenticatedApiClient } from "./api/authenticatedApiClient.js";

export interface AuthenticatedWebContext {
  user: { locale: string };
  api: AuthenticatedApiClient;
}

const authenticatedWebContext = createContext<AuthenticatedWebContext | null>(null);

export function AuthenticatedWebProvider({ value, children }: { value: AuthenticatedWebContext; children: ReactNode }) {
  return <authenticatedWebContext.Provider value={value}>{children}</authenticatedWebContext.Provider>;
}

export function useAuthenticatedWebContext(): AuthenticatedWebContext {
  const value = useContext(authenticatedWebContext);
  if (!value) throw new Error("AuthenticatedWebProvider is required");
  return value;
}
