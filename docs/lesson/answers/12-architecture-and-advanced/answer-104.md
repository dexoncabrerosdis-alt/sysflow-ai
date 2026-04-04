# Answers: Lesson 104 — State Management

## Exercise 1
**Question:** Why does Claude Code use a custom 10-line `createStore` instead of Redux, Zustand, or MobX? What are the tradeoffs? Explain why unidirectional data flow prevents bugs that bidirectional flow creates.

**Answer:** Claude Code uses a custom store because: (1) **minimal footprint** — 10 lines of code vs thousands in a framework, meaning zero dependency risk, instant comprehension, and no bundle bloat; (2) **exact requirements match** — the agent needs a reactive value with subscribers, nothing more — no middleware, devtools, or reducers; (3) **works outside React** — the store must be accessible from the agent loop, telemetry, and session persistence, not just components. The tradeoff is losing devtools, middleware ecosystem, and battle-tested edge case handling. Unidirectional data flow (store → subscribers → UI) prevents a class of bugs common in bidirectional systems: when UI components can both read and write state directly (e.g., two-way data binding), changes from one component can trigger cascading updates in another, creating circular dependencies, stale reads, and unpredictable render order. With unidirectional flow, there's exactly one way state changes: something calls `setState`, all subscribers are notified, and the UI re-renders. You can always trace a bug by asking "who called setState?"

---

## Exercise 2
**Challenge:** Implement `createStore` with batching, types, and tests.

**Answer:**

```typescript
type Listener<T> = (state: T) => void;
type Updater<T> = T | ((prev: T) => T);

interface Store<T> {
  getState: () => T;
  setState: (updater: Updater<T>) => void;
  subscribe: (listener: Listener<T>) => () => void;
  getSubscriberCount: () => number;
}

function createStore<T>(initialState: T): Store<T> {
  let state: T = initialState;
  const listeners = new Set<Listener<T>>();
  let batchDepth = 0;
  let pendingNotify = false;

  function notify() {
    if (batchDepth > 0) {
      pendingNotify = true;
      return;
    }
    listeners.forEach(listener => listener(state));
  }

  return {
    getState: () => state,

    setState: (updater: Updater<T>) => {
      const nextState = typeof updater === "function"
        ? (updater as (prev: T) => T)(state)
        : updater;
      state = nextState;
      notify();
    },

    subscribe: (listener: Listener<T>) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSubscriberCount: () => listeners.size,
  };
}

function batch<T>(store: Store<T>, fn: () => void): void {
  (store as any).batchDepth = ((store as any).batchDepth ?? 0) + 1;
  try {
    fn();
  } finally {
    (store as any).batchDepth--;
    if ((store as any).batchDepth === 0 && (store as any).pendingNotify) {
      (store as any).pendingNotify = false;
      const listeners = (store as any).listeners ?? new Set();
      listeners.forEach((l: Listener<T>) => l(store.getState()));
    }
  }
}

// Tests
function testStore() {
  // Test basic get/set
  const store = createStore({ count: 0, name: "test" });
  console.assert(store.getState().count === 0, "Initial state");

  store.setState({ count: 1, name: "test" });
  console.assert(store.getState().count === 1, "Direct set");

  // Test updater function
  store.setState(prev => ({ ...prev, count: prev.count + 10 }));
  console.assert(store.getState().count === 11, "Updater function");

  // Test subscribe/unsubscribe
  let notifyCount = 0;
  const unsub = store.subscribe(() => { notifyCount++; });
  console.assert(store.getSubscriberCount() === 1, "One subscriber");

  store.setState(prev => ({ ...prev, count: 99 }));
  console.assert(notifyCount === 1, "Subscriber notified");

  unsub();
  console.assert(store.getSubscriberCount() === 0, "Unsubscribed");

  store.setState(prev => ({ ...prev, count: 100 }));
  console.assert(notifyCount === 1, "Not notified after unsub");

  console.log("All store tests passed");
}

testStore();
```

**Explanation:** The store holds state in a closure, provides `getState` for reads, and `setState` for writes that accept either a new value or an updater function. Subscribers are stored in a `Set` for O(1) add/remove. The `notify` function checks `batchDepth` — if batching is active, it defers notification until the batch completes. The `batch` utility increments/decrements the depth and flushes pending notifications when the outermost batch finishes. Tests verify basic CRUD, updater functions, subscribe/unsubscribe, and subscriber count.

---

## Exercise 3
**Challenge:** Build `onChange` with selectors and implement three practical watchers.

**Answer:**

```typescript
function onChange<T, S>(
  store: Store<T>,
  selector: (state: T) => S,
  effect: (selectedValue: S, state: T) => void
): () => void {
  let previousValue = selector(store.getState());

  return store.subscribe((state) => {
    const currentValue = selector(state);
    if (currentValue !== previousValue) {
      previousValue = currentValue;
      effect(currentValue, state);
    }
  });
}

// Watcher 1: Log model changes
const unsubModelLog = onChange(
  appStateStore,
  state => state.model,
  (model) => {
    console.log(`[config] Model changed to: ${model}`);
  }
);

// Watcher 2: Persist messages when count changes
const unsubMessagePersist = onChange(
  appStateStore,
  state => state.messages.length,
  (_, state) => {
    const data = JSON.stringify({
      sessionId: state.sessionId,
      messages: state.messages,
      updatedAt: new Date().toISOString(),
    });
    fs.writeFile(
      path.join(SESSIONS_DIR, `${state.sessionId}.json`),
      data,
      "utf-8"
    ).catch(err => console.error("Failed to persist session:", err));
  }
);

// Watcher 3: Report token usage changes to telemetry
const unsubTokenReport = onChange(
  appStateStore,
  state => state.tokenUsage.input + state.tokenUsage.output,
  (totalTokens, state) => {
    telemetry.report({
      event: "token_usage",
      sessionId: state.sessionId,
      model: state.model,
      totalTokens,
      inputTokens: state.tokenUsage.input,
      outputTokens: state.tokenUsage.output,
    });
  }
);

// Cleanup all watchers
function cleanupWatchers() {
  unsubModelLog();
  unsubMessagePersist();
  unsubTokenReport();
}
```

**Explanation:** The `onChange` function stores the previous selected value and compares it on each state change using `!==` (referential equality). It only calls the effect when the selected value actually changes, preventing unnecessary work. The model watcher selects `state.model` — a string comparison. The message watcher selects `state.messages.length` — a number comparison that fires when messages are added or removed, triggering async file persistence. The token watcher selects the sum of input and output tokens — firing when either changes. Each watcher returns an unsubscribe function for cleanup.

---

## Exercise 4
**Challenge:** Implement `DeepImmutable<T>` with compile-time verification tests.

**Answer:**

```typescript
type DeepImmutable<T> =
  T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
    : T extends Set<infer S>
      ? ReadonlySet<DeepImmutable<S>>
      : T extends Array<infer E>
        ? ReadonlyArray<DeepImmutable<E>>
        : T extends object
          ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
          : T;

// Test types
interface AppState {
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools: string[];
  grantedPermissions: Set<string>;
  metadata: Map<string, unknown>;
  nested: {
    deep: {
      value: number;
    };
  };
}

type ImmutableAppState = DeepImmutable<AppState>;

// Compile-time tests
function testDeepImmutable(state: ImmutableAppState) {
  // @ts-expect-error — Cannot assign to readonly property
  state.model = "other";

  // @ts-expect-error — Property 'push' does not exist on ReadonlyArray
  state.messages.push({ role: "user", content: "hi" });

  // @ts-expect-error — Property 'push' does not exist on ReadonlyArray
  state.tools.push("newTool");

  // @ts-expect-error — Property 'add' does not exist on ReadonlySet
  state.grantedPermissions.add("Write");

  // @ts-expect-error — Property 'set' does not exist on ReadonlyMap
  state.metadata.set("key", "value");

  // @ts-expect-error — Cannot assign to readonly nested property
  state.nested.deep.value = 42;

  // These should work (read-only access)
  const _model: string = state.model;
  const _firstMsg = state.messages[0];
  const _hasPermission: boolean = state.grantedPermissions.has("Read");
  const _metaValue: unknown = state.metadata.get("key");
  const _deepVal: number = state.nested.deep.value;
}
```

**Explanation:** `DeepImmutable` is a recursive conditional type that handles four cases: `Map` → `ReadonlyMap`, `Set` → `ReadonlySet`, `Array` → `ReadonlyArray`, and plain objects → all properties marked `readonly`. Each case recurses into the contained types so nested structures are also immutable. The `@ts-expect-error` comments verify that TypeScript reports errors for mutation attempts — if any of these lines ever stopped producing an error (meaning the type allowed mutation), the `@ts-expect-error` annotation itself would cause a compile error, alerting you to the regression. Read-only access (`.has()`, `.get()`, property access) still works.

---

## Exercise 5
**Challenge:** Build a complete state management system with store, React context, selectors, and agent loop integration.

**Answer:**

```typescript
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";

// --- State Types ---
interface AppState {
  // Model/API
  model: string;
  apiKey: string;
  maxTokens: number;
  // Conversation
  messages: MessageParam[];
  isStreaming: boolean;
  turnCount: number;
  // UI
  theme: "dark" | "light";
  showTokenUsage: boolean;
  tokenUsage: { input: number; output: number };
}

const defaultState: AppState = {
  model: "claude-sonnet-4-20250514",
  apiKey: "",
  maxTokens: 16384,
  messages: [],
  isStreaming: false,
  turnCount: 0,
  theme: "dark",
  showTokenUsage: true,
  tokenUsage: { input: 0, output: 0 },
};

// --- Store ---
const appStore = createStore<AppState>(defaultState);

// --- React Context ---
const AppStateContext = createContext<{
  state: AppState;
  setState: (updater: AppState | ((prev: AppState) => AppState)) => void;
} | null>(null);

function AppStateProvider({
  children,
  initialSettings,
}: {
  children: React.ReactNode;
  initialSettings?: Partial<AppState>;
}) {
  const [state, setReactState] = useState<AppState>(() => ({
    ...defaultState,
    ...initialSettings,
  }));

  useEffect(() => {
    if (initialSettings) {
      appStore.setState(prev => ({ ...prev, ...initialSettings }));
    }
    return appStore.subscribe(setReactState);
  }, []);

  const setState = useCallback(
    (updater: AppState | ((prev: AppState) => AppState)) => {
      appStore.setState(updater);
    },
    []
  );

  return (
    <AppStateContext.Provider value={{ state, setState }}>
      {children}
    </AppStateContext.Provider>
  );
}

// --- Hooks ---
function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState requires AppStateProvider");
  return ctx.state;
}

function useSetAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useSetAppState requires AppStateProvider");
  return ctx.setState;
}

function useSelector<S>(selector: (state: AppState) => S): S {
  const state = useAppState();
  const prevRef = useRef<S>(selector(state));
  const selected = selector(state);

  return useMemo(() => {
    if (selected !== prevRef.current) {
      prevRef.current = selected;
    }
    return prevRef.current;
  }, [selected]);
}

// --- Agent Loop Integration ---
async function processAgentTurn(
  message: string,
  options: { model: string; maxTurns: number }
) {
  appStore.setState(prev => ({
    ...prev,
    isStreaming: true,
    messages: [...prev.messages, { role: "user" as const, content: message }],
  }));

  const events = query(
    { role: "user", content: message },
    { model: options.model, maxTurns: options.maxTurns }
  );

  for await (const event of events) {
    switch (event.type) {
      case "assistant_text":
        appStore.setState(prev => ({
          ...prev,
          messages: appendToLast(prev.messages, event.content),
        }));
        break;

      case "turn_complete":
        appStore.setState(prev => ({
          ...prev,
          isStreaming: false,
          turnCount: prev.turnCount + 1,
          tokenUsage: {
            input: prev.tokenUsage.input + event.usage.input,
            output: prev.tokenUsage.output + event.usage.output,
          },
        }));
        break;
    }
  }
}

// --- Usage in Components ---
function StatusBar() {
  const model = useSelector(s => s.model);
  const tokenUsage = useSelector(s => s.tokenUsage);
  const showTokens = useSelector(s => s.showTokenUsage);

  return (
    <Box>
      <Text>Model: {model}</Text>
      {showTokens && (
        <Text> | Tokens: {tokenUsage.input}↓ {tokenUsage.output}↑</Text>
      )}
    </Box>
  );
}
```

**Explanation:** The system has four layers: (1) the `createStore` primitive holds state outside React, (2) `AppStateProvider` syncs store changes to React context via `subscribe`, (3) `useAppState` and `useSelector` hooks let components read state (with `useSelector` providing granular re-render control), and (4) `processAgentTurn` updates the store from the agent loop. When the agent loop calls `appStore.setState`, the store notifies its subscriber (the provider), which calls `setReactState`, causing React to re-render components that read the changed state. The full flow: agent event → `setState` → store notification → React context update → component re-render.
