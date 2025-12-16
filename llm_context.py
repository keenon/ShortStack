import os
import pyperclip

# Directories to scan relative to the script location
TARGET_DIRS = ["src", "src-tauri/src"]

# Extensions to include (add or remove as needed)
# Since this is a Tauri project, we primarily want Rust, JS/TS, CSS, HTML, and Configs
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
                    # Create relative path from the project root (e.g., src/components/Button.tsx)
                    full_path = os.path.join(root, file)
                    # Normalize path separators for consistency (forward slashes)
                    normalized_path = full_path.replace("\\", "/")
                    
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