/**
 * Déclarations minimales de React 19 pour typer l'interface hors-ligne (sandbox sans accès au registre npm).
 * Dès que `npm install` est possible : supprimer ce fichier et typings/node-shims.d.ts — @types/react,
 * @types/react-dom et @types/node (déjà en devDependencies) prennent le relais.
 * Les éléments JSX sont volontairement permissifs ; tout le code métier reste en TypeScript strict.
 */
declare module "react" {
  export type Key = string | number;
  export type ReactNode = unknown;
  export interface ReactElement { type: unknown; props: unknown; key: Key | null }
  export type CSSProperties = Record<string, string | number | undefined>;
  export type Dispatch<A> = (value: A) => void;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export interface RefObject<T> { current: T }
  export type PropsWithChildren<P = unknown> = P & { children?: ReactNode };
  export type FC<P = Record<string, never>> = (props: P) => ReactNode;
  export type ComponentType<P = Record<string, never>> = FC<P>;
  export interface SyntheticEvent<T = Element> { currentTarget: T; target: EventTarget & Element; preventDefault(): void; stopPropagation(): void; nativeEvent: Event }
  export type ChangeEvent<T = Element> = SyntheticEvent<T> & { target: T };
  export type FormEvent<T = Element> = SyntheticEvent<T>;
  export type MouseEvent<T = Element> = SyntheticEvent<T> & { clientX: number; clientY: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; button: number };
  export type KeyboardEvent<T = Element> = SyntheticEvent<T> & { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };
  export type PointerEvent<T = Element> = MouseEvent<T>;
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useReducer<S, A>(reducer: (s: S, a: A) => S, initial: S): [S, Dispatch<A>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  export function useRef<T>(initial: T): RefObject<T>;
  export function useId(): string;
  export function useContext<T>(ctx: Context<T>): T;
  export function useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T;
  export function useDeferredValue<T>(v: T): T;
  export function startTransition(fn: () => void): void;
  export interface Context<T> { Provider: FC<{ value: T; children?: ReactNode }>; Consumer: unknown }
  export function createContext<T>(def: T): Context<T>;
  export function memo<T>(c: T): T;
  export const Fragment: FC<{ children?: ReactNode }>;
  export function cloneElement(el: unknown, props?: unknown): ReactElement;
  export function isValidElement(x: unknown): boolean;
  export const StrictMode: FC<{ children?: ReactNode }>;
  const React: unknown;
  export default React;
}
declare module "react/jsx-runtime" {
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown;
  export const Fragment: unique symbol;
  export namespace JSX {
    type Element = unknown;
    interface ElementChildrenAttribute { children: unknown }
    interface IntrinsicAttributes { key?: string | number }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interface DomProps {
      onClick?: (e: import("react").MouseEvent<HTMLElement>) => void;
      onMouseMove?: (e: import("react").MouseEvent<SVGSVGElement & HTMLElement>) => void;
      onMouseLeave?: (e: import("react").MouseEvent<HTMLElement>) => void;
      onChange?: (e: import("react").ChangeEvent<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>) => void;
      onKeyDown?: (e: import("react").KeyboardEvent<HTMLElement>) => void;
      onSubmit?: (e: import("react").FormEvent<HTMLFormElement>) => void;
      [attr: string]: any;
    }
    interface IntrinsicElements { [tag: string]: DomProps }
  }
}
declare module "react-dom/client" {
  export function createRoot(el: Element | DocumentFragment): { render(node: unknown): void; unmount(): void };
}
declare module "*.css" {}
