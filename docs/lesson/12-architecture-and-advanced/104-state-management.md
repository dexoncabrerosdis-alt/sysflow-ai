# Lesson 104: State Management

## The Problem with Global State

An agent has a lot of state: the current model, tools, permissions granted, token usage, active MCP connections, feature flags, conversation history. This state needs to be accessible from React components, from the query loop, from tool implementations.

You could use a big state management library — Redux, Zustand, MobX. But Claude Code needs something simpler: a reactive store that's tiny, typed, and works with React. No middleware. No actions. No reducers. Just a value that notifies subscribers when it changes.

## createStore: 10 Lines of Reactive State

The entire state management system is built on this function:

```typescript
type Listener<T> = (state: T) => void;

function createStore<T>(initialState: T) {
  let state: T = initialState;
  const listeners = new Set<Listener<T>>();

  return {
    getState: () => state,
    setState: (updater: T | ((prev: T) => T)) => {
      const nextState = typeof updater === "function"
        ? (updater as (prev: T) => T)(state)
        : updater;
      state = nextState;
      listeners.forEach(listener => listener(state));
    },
    subscribe: (listener: Listener<T>) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
```

That's it. No framework. No dependencies. A value, a setter that notifies, and a subscribe function. This is the entire foundation of Claude Code's state management.

It works like `useState`, but outside of React:

```typescript
const store = createStore({ count: 0 });

// Read
console.log(store.getState().count); // 0

// Update
store.setState(prev => ({ ...prev, count: prev.count + 1 }));

// Subscribe
const unsubscribe = store.subscribe(state => {
  console.log("Count changed:", state.count);
});
```

## AppState: The Global State Type

All application state lives in a single type:

```typescript
interface AppState {
  // Model and API
  model: string;
  apiKey: string;
  maxTokens: number;

  // Conversation
  messages: MessageParam[];
  isStreaming: boolean;
  currentTurnIndex: number;

  // Tools and permissions
  tools: Tool[];
  grantedPermissions: Set<string>;
  deniedPermissions: Set<string>;

  // MCP
  mcpConnections: McpConnection[];
  mcpToolCount: number;

  // UI state
  inputMode: "normal" | "plan" | "compact";
  theme: "dark" | "light";
  showTokenUsage: boolean;

  // Session
  sessionId: string;
  cwd: string;

  // Telemetry
  tokenUsage: TokenUsage;
  turnCount: number;
  toolCallCount: number;

  // Feature flags
  features: Record<string, boolean>;
}
```

One type. One store. One source of truth. No state spread across multiple stores or contexts.

## AppStateStore: Defaults and Initialization

The store is created with sensible defaults:

```typescript
const defaultAppState: AppState = {
  model: "claude-sonnet-4-20250514",
  apiKey: "",
  maxTokens: 16384,

  messages: [],
  isStreaming: false,
  currentTurnIndex: 0,

  tools: [],
  grantedPermissions: new Set(),
  deniedPermissions: new Set(),

  mcpConnections: [],
  mcpToolCount: 0,

  inputMode: "normal",
  theme: "dark",
  showTokenUsage: true,

  sessionId: crypto.randomUUID(),
  cwd: process.cwd(),

  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  turnCount: 0,
  toolCallCount: 0,

  features: {},
};

// Create the global store
const appStateStore = createStore<AppState>(defaultAppState);
```

## AppStateProvider: React Context Wrapper

To use the store in React components, it's wrapped in a context provider:

```typescript
const AppStateContext = createContext<{
  state: AppState;
  setState: (updater: AppState | ((prev: AppState) => AppState)) => void;
} | null>(null);

function AppStateProvider({
  children,
  initialSettings,
}: {
  children: React.ReactNode;
  initialSettings: Settings;
}) {
  const [state, setReactState] = useState<AppState>(() => ({
    ...defaultAppState,
    model: initialSettings.model,
    apiKey: initialSettings.apiKey,
    features: initialSettings.features,
  }));

  // Sync React state with the external store
  useEffect(() => {
    const unsubscribe = appStateStore.subscribe((newState) => {
      setReactState(newState);
    });
    return unsubscribe;
  }, []);

  const setState = useCallback((updater: AppState | ((prev: AppState) => AppState)) => {
    appStateStore.setState(updater);
  }, []);

  return (
    <AppStateContext.Provider value={{ state, setState }}>
      {children}
    </AppStateContext.Provider>
  );
}
```

Components consume state with a custom hook:

```typescript
function useAppState(): AppState {
  const context = useContext(AppStateContext);
  if (!context) throw new Error("useAppState must be used within AppStateProvider");
  return context.state;
}

function useSetAppState() {
  const context = useContext(AppStateContext);
  if (!context) throw new Error("useSetAppState must be used within AppStateProvider");
  return context.setState;
}
```

## Selectors for Derived State

Instead of storing computed values, use selectors:

```typescript
function useTokenCost(): number {
  const { tokenUsage, model } = useAppState();
  return useMemo(() => {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;

    return (
      (tokenUsage.input * pricing.inputPer1k / 1000) +
      (tokenUsage.output * pricing.outputPer1k / 1000) +
      (tokenUsage.cacheRead * pricing.cacheReadPer1k / 1000)
    );
  }, [tokenUsage, model]);
}

function useAvailableTools(): Tool[] {
  const { tools, features } = useAppState();
  return useMemo(() => {
    return tools.filter(tool => {
      if (tool.featureFlag && !features[tool.featureFlag]) return false;
      return true;
    });
  }, [tools, features]);
}

function useIsToolGranted(toolName: string): boolean {
  const { grantedPermissions } = useAppState();
  return grantedPermissions.has(toolName);
}
```

Selectors are just hooks that derive values from state. They use `useMemo` to avoid recomputation.

## onChangeAppState: Side Effects on State Changes

Sometimes you need to react to state changes outside of React — logging, telemetry, persistence:

```typescript
function onChangeAppState(
  selector: (state: AppState) => unknown,
  effect: (state: AppState) => void,
): () => void {
  let previousValue = selector(appStateStore.getState());

  return appStateStore.subscribe((state) => {
    const currentValue = selector(state);
    if (currentValue !== previousValue) {
      previousValue = currentValue;
      effect(state);
    }
  });
}

// Log model changes
onChangeAppState(
  state => state.model,
  state => console.log(`Model changed to: ${state.model}`)
);

// Persist session state when messages change
onChangeAppState(
  state => state.messages.length,
  state => saveSession(state.sessionId, state.messages)
);

// Report token usage to telemetry
onChangeAppState(
  state => state.tokenUsage,
  state => reportTokenUsage(state.sessionId, state.tokenUsage)
);
```

This is similar to Zustand's `subscribe` with selectors, but built from scratch.

## Immutable State with DeepImmutable

To prevent accidental mutation, the state type uses a deep immutable wrapper:

```typescript
type DeepImmutable<T> =
  T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
    : T extends Set<infer S>
      ? ReadonlySet<DeepImmutable<S>>
      : T extends object
        ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
        : T;

type ImmutableAppState = DeepImmutable<AppState>;
```

With this type, the compiler catches mutation attempts:

```typescript
const state: ImmutableAppState = store.getState();

state.model = "other"; // TS Error: Cannot assign to 'model' — read-only
state.messages.push(msg); // TS Error: Property 'push' does not exist on readonly array
state.grantedPermissions.add("tool"); // TS Error: Property 'add' does not exist on ReadonlySet
```

Updates must go through `setState` with a new object:

```typescript
store.setState(prev => ({
  ...prev,
  model: "claude-opus-4-20250514",
  messages: [...prev.messages, newMessage],
  grantedPermissions: new Set([...prev.grantedPermissions, "Write"]),
}));
```

## How State Flows Through the System

```
┌─────────────────────────────────────┐
│           createStore()             │
│  ┌───────────────────────────────┐  │
│  │         AppState              │  │
│  │  model, messages, tools, ...  │  │
│  └───────────┬───────────────────┘  │
│              │                      │
│    ┌─────────┼─────────────┐        │
│    │         │             │        │
│    ▼         ▼             ▼        │
│ subscribe  subscribe   subscribe    │
│    │         │             │        │
└────┼─────────┼─────────────┼────────┘
     │         │             │
     ▼         ▼             ▼
 ┌───────┐ ┌───────┐  ┌──────────┐
 │ React │ │Telemetry│ │ Session  │
 │Context│ │Reporter│  │ Persist  │
 └───┬───┘ └───────┘  └──────────┘
     │
     ▼
 ┌───────────────┐
 │  Components   │
 │ useAppState() │
 │ re-render on  │
 │ state change  │
 └───────────────┘
```

1. Something calls `setState` (tool execution, API response, user input)
2. All subscribers are notified synchronously
3. React subscriber updates context → components re-render
4. Telemetry subscriber reports metrics
5. Session subscriber persists state

## State Updates from the Agent Loop

The agent loop updates state as it processes events:

```typescript
async function processAgentTurn(store: Store<AppState>) {
  store.setState(prev => ({ ...prev, isStreaming: true }));

  for await (const event of query(message, options)) {
    switch (event.type) {
      case "assistant_text":
        store.setState(prev => ({
          ...prev,
          messages: appendToLastMessage(prev.messages, event.content),
        }));
        break;

      case "tool_use":
        store.setState(prev => ({
          ...prev,
          toolCallCount: prev.toolCallCount + 1,
        }));
        break;

      case "turn_complete":
        store.setState(prev => ({
          ...prev,
          isStreaming: false,
          turnCount: prev.turnCount + 1,
          tokenUsage: addUsage(prev.tokenUsage, event.usage),
        }));
        break;
    }
  }
}
```

## Key Takeaways

1. **`createStore` is ~10 lines** — no framework needed for reactive state
2. **Single `AppState` type** — one source of truth for all application state
3. **React integration** via context provider and `useAppState` hook
4. **Selectors** derive computed values with `useMemo`
5. **`onChangeAppState`** triggers side effects when specific state slices change
6. **`DeepImmutable`** prevents accidental mutation at the type level
7. **State flows unidirectionally**: store → subscribers → UI/effects

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Reactive Store Design
**Question:** Why does Claude Code use a custom 10-line `createStore` instead of Redux, Zustand, or MobX? What are the tradeoffs? Explain why unidirectional data flow (store → subscribers → UI) prevents the class of bugs that bidirectional data flow creates.

[View Answer](../../answers/12-architecture-and-advanced/answer-104.md#exercise-1)

### Exercise 2 — Build createStore from Scratch
**Challenge:** Implement the `createStore` function with full TypeScript types. It should support: `getState()`, `setState()` with both direct value and updater function, `subscribe()` that returns an unsubscribe function, and batch notifications (if multiple `setState` calls happen synchronously, only notify subscribers once). Add a `getSubscriberCount()` method for debugging. Write tests that verify subscribe/unsubscribe, updater functions, and batching.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-104.md#exercise-2)

### Exercise 3 — Implement onChangeAppState with Selectors
**Challenge:** Build an `onChange` function that watches a specific slice of state and only fires a callback when that slice changes. It should accept a selector function and an effect function, and use referential equality to detect changes. Then implement three practical watchers: (1) log when the model changes, (2) persist messages to disk when message count changes, (3) report token usage to telemetry when token totals change. Include proper cleanup (unsubscribe) for each watcher.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-104.md#exercise-3)

### Exercise 4 — DeepImmutable Type
**Challenge:** Implement the `DeepImmutable<T>` utility type that recursively makes all properties readonly, arrays into readonly arrays, Maps into ReadonlyMaps, and Sets into ReadonlySets. Then write a test file that demonstrates: (1) trying to assign to a property fails, (2) trying to `push` to an array fails, (3) trying to `add` to a Set fails, (4) trying to `set` on a Map fails, and (5) nested objects are also readonly. All "failures" should be compile-time TypeScript errors (use `// @ts-expect-error` annotations).

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-104.md#exercise-4)

### Exercise 5 — Full AppState Integration
**Challenge:** Build a complete state management system: create an `AppState` interface with at least 8 fields across 3 categories (model/API, conversation, UI), implement `createStore` with it, create an `AppStateProvider` React component that syncs the store with React context, implement a `useAppState` hook and a `useSelector` hook (that only triggers re-renders when the selected value changes), and wire up an agent loop function that updates state as it processes events. Demonstrate the full flow from event to state change to UI update.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-104.md#exercise-5)
