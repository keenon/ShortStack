import React, { useState, useRef, useEffect, KeyboardEvent } from "react";
import * as math from "mathjs";
import { Parameter } from "../types";
import "./ExpressionEditor.css";

interface Props {
  value: string;
  onChange: (val: string) => void;
  params: Parameter[];
  placeholder?: string;
  hasError?: boolean; // Kept for backward compatibility or external errors, though internal logic takes precedence for display
}

export default function ExpressionEditor({
  value,
  onChange,
  params,
  placeholder,
  hasError: externalError,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filtered, setFiltered] = useState<Parameter[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [cursorOffset, setCursorOffset] = useState(0);

  // Evaluation State
  const [evalResult, setEvalResult] = useState<number | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);

  // Evaluate whenever value or params change
  useEffect(() => {
    if (!value || !value.trim()) {
      setEvalResult(null);
      setEvalError(null);
      return;
    }

    try {
      const scope: Record<string, any> = {};
      params.forEach((p) => {
        // Treat parameters as pure numbers in mm
        const val = p.unit === "in" ? p.value * 25.4 : p.value;
        scope[p.key] = val;
      });

      const result = math.evaluate(value, scope);
      
      let valInMm = 0;
      if (typeof result === "number") {
        valInMm = result;
      } else if (result && typeof result.toNumber === "function") {
        valInMm = result.toNumber("mm");
      } else {
         // If it's a unit object but we can't convert or it's unexpected
         // Try to convert to number if possible, or just error if it's complex
         // For this simple editor, we assume scalar or length
         throw new Error("Invalid result type");
      }

      setEvalResult(valInMm);
      setEvalError(null);
    } catch (err: any) {
      setEvalResult(null);
      setEvalError("Invalid"); // Keep error message short
    }
  }, [value, params]);

  // Measure text width to position the dropdown
  function getCursorPixelPosition(textBeforeCursor: string): number {
    if (!inputRef.current) return 0;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return 0;
    
    // Copy font styles from input to canvas context
    const styles = window.getComputedStyle(inputRef.current);
    context.font = `${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
    
    return context.measureText(textBeforeCursor).width;
  }

  // Helper: Get the word currently being typed immediately before cursor
  function getCurrentWord(text: string, cursorIndex: number) {
    const textBefore = text.slice(0, cursorIndex);
    const match = textBefore.match(/([a-zA-Z0-9_]+)$/); // Match alphanumeric + underscore at end
    return match ? { word: match[1], start: match.index! } : null;
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    const newCursorPos = e.target.selectionStart || 0;
    
    onChange(newValue);
    updateSuggestions(newValue, newCursorPos);
  };

  const updateSuggestions = (text: string, cursorPos: number) => {
    const match = getCurrentWord(text, cursorPos);

    if (match) {
      const search = match.word.toLowerCase();
      // Filter params that start with or contain the search term
      const matches = params.filter((p) =>
        p.key.toLowerCase().includes(search)
      );

      if (matches.length > 0) {
        setFiltered(matches);
        setSelectedIndex(0); // Reset selection to top
        setShowSuggestions(true);
        
        // Calculate pixel position for dropdown
        const pixelPos = getCursorPixelPosition(text.slice(0, match.start));
        // Add a small buffer/padding offset
        setCursorOffset(pixelPos + 8); 
        return;
      }
    }
    
    setShowSuggestions(false);
  };

  const insertSuggestion = (param: Parameter) => {
    if (!inputRef.current) return;
    
    const cursorPos = inputRef.current.selectionStart || 0;
    const match = getCurrentWord(value, cursorPos);
    
    if (match) {
      const before = value.slice(0, match.start);
      const after = value.slice(cursorPos);
      const newValue = before + param.key + after;
      
      onChange(newValue);
      setShowSuggestions(false);
      
      // Restore focus and move cursor to end of inserted word
      // Use setTimeout to ensure React render cycle completes
      setTimeout(() => {
        if(inputRef.current) {
            inputRef.current.focus();
            const newCursor = match.start + param.key.length;
            inputRef.current.setSelectionRange(newCursor, newCursor);
        }
      }, 0);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Tab" || e.key === "Enter") {
      // Logic: If list open, Tab/Enter selects the item. 
      // If list closed, Tab moves focus naturally.
      e.preventDefault();
      insertSuggestion(filtered[selectedIndex]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  // Close suggestions on blur, but allow time for click events on the list
  const handleBlur = () => {
    setTimeout(() => setShowSuggestions(false), 200);
  };

  const isError = externalError || evalError !== null;

  return (
    <div className="expression-editor-wrapper">
      <div className="input-container">
        <input
            ref={inputRef}
            type="text"
            className={`expression-input ${isError ? "error" : ""}`}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={placeholder}
            autoComplete="off"
        />
        {/* Result Badge */}
        {value && value.trim() && (
            <div className={`expression-result-badge ${evalError ? "error" : "success"}`}>
                {evalError ? "!" : `= ${evalResult?.toFixed(2)}`}
            </div>
        )}
      </div>

      {showSuggestions && (
        <ul 
            className="autocomplete-dropdown"
            style={{ left: cursorOffset }}
        >
          {filtered.map((item, index) => (
            <li
              key={item.id}
              className={index === selectedIndex ? "active" : ""}
              onMouseDown={(e) => {
                // Prevent input blur before click registers
                e.preventDefault(); 
                insertSuggestion(item);
              }}
            >
              <span className="var-key">{item.key}</span>
              <span className="var-value">
                 = {item.value} <small>{item.unit}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}