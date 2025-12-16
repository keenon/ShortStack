import os
import sys
import pyperclip

# Directories to scan relative to the script location
TARGET_DIRS = ["src", "src-tauri/src"]

# Extensions to include (add or remove as needed)
VALID_EXTENSIONS = {
    ".rs", ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".svelte", ".vue", ".json", ".toml"
}

def get_file_content(filepath):
    """Reads file content and returns it formatted."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
            
        # Format: `path`: \n ```\n content \n```
        return f"`{filepath}`:\n```\n{content}\n```\n\n"
    except Exception as e:
        print(f"Skipping {filepath}: {e}")
        return ""

def main():
    # Capture command line arguments (skipping the script name itself)
    keywords = sys.argv[1:]
    
    if keywords:
        print(f"🔍 Filtering for paths containing: {', '.join(keywords)}")
    else:
        print("📂 No keywords provided. Scanning all valid files...")

    output_buffer = []
    
    # Iterate over specific target directories
    for root_dir in TARGET_DIRS:
        if not os.path.exists(root_dir):
            print(f"Warning: Directory '{root_dir}' not found. Skipping.")
            continue

        for root, _, files in os.walk(root_dir):
            for file in files:
                # Filter by extension to avoid binary files or unwanted assets
                if any(file.endswith(ext) for ext in VALID_EXTENSIONS):
                    # Create relative path from the project root
                    full_path = os.path.join(root, file)
                    # Normalize path separators for consistency (forward slashes)
                    normalized_path = full_path.replace("\\", "/")
                    
                    # --- NEW LOGIC: Keyword Filtering ---
                    if keywords:
                        # Check if ANY of the keywords exist in the path (case insensitive)
                        # We use normalized_path so it matches against folder names too
                        if not any(k.lower() in normalized_path.lower() for k in keywords):
                            continue # Skip this file if no keywords match
                    # ------------------------------------

                    output_buffer.append(get_file_content(normalized_path))

    final_output = "".join(output_buffer)

    if final_output:
        pyperclip.copy(final_output)
        print("✅ Context generated and copied to clipboard successfully!")
        print(f"   (Copied {len(output_buffer)} files)")
    else:
        print("❌ No matching files found to copy.")

if __name__ == "__main__":
    main()