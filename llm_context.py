import os
import sys
import pyperclip
import re

# Directories to scan relative to the script location
TARGET_DIRS = ["src", "src-tauri/src", ".github/workflows"]

# Extensions to include
VALID_EXTENSIONS = {
    ".rs", ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".svelte", ".vue", ".json", ".toml", ".py"
}

# Regex patterns for finding imports
REGEX_PATTERNS = {
    # TypeScript/JS: matches "import ... from 'path'" or "export ... from 'path'" or "require('path')"
    "ts": re.compile(r"""(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)"""),
    # Python: matches "from x.y import z" or "import x"
    "py": re.compile(r"""^\s*(?:from\s+([\w\.]+)\s+import|import\s+([\w\.]+))""", re.MULTILINE),
    # Rust: matches "mod x;" (ignores 'use' as resolving crate roots is too complex for regex)
    "rs": re.compile(r"""^\s*mod\s+([a-zA-Z0-9_]+)\s*;""", re.MULTILINE),
}

def get_file_content(filepath):
    """Reads file content."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        print(f"Skipping {filepath}: {e}")
        return None

def resolve_ts_path(base_dir, import_path):
    """Resolves TS/JS relative paths (e.g., './utils' -> './utils.ts')."""
    # Only follow relative paths (ignore libraries/node_modules)
    if not import_path.startswith("."):
        return None

    full_path_base = os.path.join(base_dir, import_path)
    
    # Extensions to try if implicit
    extensions_to_try = [".ts", ".tsx", ".js", ".jsx", ".svelte", ".vue", "/index.ts", "/index.tsx", "/index.js"]
    
    # Check exact match first (rare for imports but possible)
    if os.path.exists(full_path_base) and os.path.isfile(full_path_base):
        return full_path_base
        
    for ext in extensions_to_try:
        candidate = full_path_base + ext
        if os.path.exists(candidate):
            return candidate
    return None

def resolve_py_path(base_dir, import_str):
    """Resolves Python dot notation to file paths."""
    # Convert 'app.utils' to 'app/utils'
    rel_path = import_str.replace(".", "/")
    
    # 1. Try relative to current file location
    candidate_local = os.path.join(base_dir, rel_path + ".py")
    if os.path.exists(candidate_local):
        return candidate_local
    
    candidate_pkg = os.path.join(base_dir, rel_path, "__init__.py")
    if os.path.exists(candidate_pkg):
        return candidate_pkg

    # 2. Try relative to project roots (Absolute imports inside project)
    # We walk up from base_dir to find if valid anywhere
    # (Simplified: just check against CWD/Target dirs)
    for root in TARGET_DIRS:
        if os.path.exists(root):
            candidate_root = os.path.join(root, rel_path + ".py")
            if os.path.exists(candidate_root):
                return candidate_root
            candidate_root_pkg = os.path.join(root, rel_path, "__init__.py")
            if os.path.exists(candidate_root_pkg):
                return candidate_root_pkg
            
    return None

def resolve_rs_path(base_dir, mod_name):
    """Resolves Rust 'mod name;' to files."""
    # Try `name.rs`
    c1 = os.path.join(base_dir, f"{mod_name}.rs")
    if os.path.exists(c1): return c1
    
    # Try `name/mod.rs`
    c2 = os.path.join(base_dir, mod_name, "mod.rs")
    if os.path.exists(c2): return c2
    
    return None

def scan_imports(content, filepath):
    """Scans content for imports and returns a list of resolved absolute file paths."""
    imports_found = []
    base_dir = os.path.dirname(filepath)
    ext = os.path.splitext(filepath)[1]

    if ext in [".ts", ".tsx", ".js", ".jsx", ".svelte", ".vue"]:
        matches = REGEX_PATTERNS["ts"].findall(content)
        for m in matches:
            # Regex group 0 is 'from', group 1 is 'require'
            path_str = m[0] if m[0] else m[1]
            resolved = resolve_ts_path(base_dir, path_str)
            if resolved: imports_found.append(resolved)

    elif ext == ".py":
        matches = REGEX_PATTERNS["py"].findall(content)
        for m in matches:
            # Group 0 is 'from X', Group 1 is 'import X'
            import_str = m[0] if m[0] else m[1]
            resolved = resolve_py_path(base_dir, import_str)
            if resolved: imports_found.append(resolved)

    elif ext == ".rs":
        matches = REGEX_PATTERNS["rs"].findall(content)
        for mod_name in matches:
            resolved = resolve_rs_path(base_dir, mod_name)
            if resolved: imports_found.append(resolved)

    return imports_found

def main():
    args = sys.argv[1:]
    
    # Check for flag to disable recursive imports
    follow_imports = False
    if "--with-imports" in args:
        follow_imports = True
        args.remove("--with-imports")
        print("✅ Import following enabled.")
    
    keywords = args
    
    if keywords:
        print(f"🔍 Filtering for paths containing: {', '.join(keywords)}")
    else:
        print("📂 No keywords provided. Scanning all valid files...")

    # Set of file paths (normalized) to process
    files_queue = []
    
    # 1. Initial Scan based on Keywords
    for root_dir in TARGET_DIRS:
        if not os.path.exists(root_dir):
            continue

        for root, _, files in os.walk(root_dir):
            for file in files:
                if any(file.endswith(ext) for ext in VALID_EXTENSIONS):
                    full_path = os.path.join(root, file)
                    normalized_path = full_path.replace("\\", "/")
                    
                    if keywords:
                        if not any(k.lower() in normalized_path.lower() for k in keywords):
                            continue 
                    
                    files_queue.append(os.path.abspath(normalized_path))

    # 2. Process Queue (Read content + Follow Imports)
    processed_files = set()
    final_output_blocks = []

    # Use an index to iterate so we can append to the list while looping
    idx = 0
    while idx < len(files_queue):
        current_abs_path = files_queue[idx]
        idx += 1
        
        # Deduplication
        if current_abs_path in processed_files:
            continue
        processed_files.add(current_abs_path)
        
        # Get relative path for display
        rel_path = os.path.relpath(current_abs_path, os.getcwd()).replace("\\", "/")
        
        content = get_file_content(current_abs_path)
        if content is None:
            continue

        # Format Output
        final_output_blocks.append(f"`{rel_path}`:\n```\n{content}\n```\n\n")

        # Recursively find imports
        if follow_imports:
            new_imports = scan_imports(content, current_abs_path)
            for imp in new_imports:
                if imp not in processed_files:
                    files_queue.append(imp)

    final_output = "".join(final_output_blocks)

    if final_output:
        pyperclip.copy(final_output)
        print("✅ Context generated and copied to clipboard successfully!")
        print(f"   (Processed {len(processed_files)} files)")
    else:
        print("❌ No matching files found to copy.")

if __name__ == "__main__":
    main()