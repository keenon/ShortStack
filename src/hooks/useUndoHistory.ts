// src/hooks/useUndoHistory.ts
import { useState, useCallback, useRef } from "react";

interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

export function useUndoHistory<T>(initialState: T, timeout = 500) {
  const [history, setHistory] = useState<HistoryState<T>>({
    past: [],
    present: initialState,
    future: [],
  });

  // Track the timestamp of the last state change to group rapid updates
  const lastChangeTime = useRef<number>(0);

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  const undo = useCallback(() => {
    setHistory((curr) => {
      if (curr.past.length === 0) return curr;
      
      const previous = curr.past[curr.past.length - 1];
      const newPast = curr.past.slice(0, -1);

      return {
        past: newPast,
        present: previous,
        future: [curr.present, ...curr.future],
      };
    });
    // Reset timer so next action is always a new history entry
    lastChangeTime.current = 0; 
  }, []);

  const redo = useCallback(() => {
    setHistory((curr) => {
      if (curr.future.length === 0) return curr;

      const next = curr.future[0];
      const newFuture = curr.future.slice(1);

      return {
        past: [...curr.past, curr.present],
        present: next,
        future: newFuture,
      };
    });
    lastChangeTime.current = 0;
  }, []);

  const set = useCallback((newState: T) => {
    const now = Date.now();
    const timeDiff = now - lastChangeTime.current;

    setHistory((curr) => {
      // Logic:
      // If the change happens very quickly (e.g. dragging a slider),
      // we update the 'present' in place without pushing the previous 'present' to 'past'.
      // This ensures that the 'past' holds the state from BEFORE the drag started.
      
      if (timeDiff > timeout) {
        // New distinct action
        return {
          past: [...curr.past, curr.present],
          present: newState,
          future: [], // Clear redo stack on new change
        };
      } else {
        // Continuation of current action (grouping)
        return {
          ...curr,
          present: newState,
          // We keep the existing 'past' untouched, effectively squashing 
          // intermediate drag/type states.
          future: [],
        };
      }
    });

    lastChangeTime.current = now;
  }, [timeout]);

  return {
    state: history.present,
    set,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory: (newState: T) => {
        setHistory({ past: [], present: newState, future: [] });
        lastChangeTime.current = 0;
    }
  };
}