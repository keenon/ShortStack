#!/usr/bin/env python3
import sys
import os
import subprocess
import difflib
import re
import argparse

# Regex patterns for stripping comments while preserving strings.
# The goal is to identify if the "code" remaining after stripping comments
# and whitespace is identical between the original and the new version.
# Each tuple is (list of extensions, regex pattern).

# Python style: # comments, but handles quotes and triple quotes.
# Note: Triple quotes must come before single/double quotes in the regex.
PYTHON_PATTERN = r'(\"\"\"[\s\S]*?\"\"\"|\'\'\'[\s\S]*?\'\'\'|\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|#.*)'

# C-style: // and /* */, handles double and single quotes.
C_STYLE_PATTERN = r'(\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|//.*|/\*[\s\S]*?\*/)'

# JSX adds {/* ... */} style comments to C-style.
JSX_STYLE_PATTERN = r'(\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|//.*|/\*[\s\S]*?\*/|\{/\*[\s\S]*?\*\/\})'

# HTML/XML: <!-- -->, handles quotes (attributes).
HTML_PATTERN = r'(\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|<!--[\s\S]*?-->)'

# SQL: -- and /* */
SQL_PATTERN = r'(\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|/\*[\s\S]*?\*/|--.*)'

# Lua: -- (simple line comment)
LUA_PATTERN = r'(\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|--.*)'

EXTENSION_MAP = {
    # Python
    '.py': PYTHON_PATTERN, '.pyw': PYTHON_PATTERN,
    '.rb': PYTHON_PATTERN, '.sh': PYTHON_PATTERN, '.yaml': PYTHON_PATTERN, '.yml': PYTHON_PATTERN,
    '.toml': PYTHON_PATTERN, '.dockerfile': PYTHON_PATTERN,
    # C-style
    '.c': C_STYLE_PATTERN, '.cpp': C_STYLE_PATTERN, '.h': C_STYLE_PATTERN, '.hpp': C_STYLE_PATTERN,
    '.js': C_STYLE_PATTERN, '.ts': C_STYLE_PATTERN,
    '.java': C_STYLE_PATTERN, '.cs': C_STYLE_PATTERN, '.go': C_STYLE_PATTERN, '.rs': C_STYLE_PATTERN,
    '.swift': C_STYLE_PATTERN, '.kt': C_STYLE_PATTERN, '.scala': C_STYLE_PATTERN, '.dart': C_STYLE_PATTERN,
    '.php': C_STYLE_PATTERN,
    '.css': C_STYLE_PATTERN, '.scss': C_STYLE_PATTERN, '.less': C_STYLE_PATTERN,
    # JSX
    '.jsx': JSX_STYLE_PATTERN, '.tsx': JSX_STYLE_PATTERN,
    # HTML
    '.html': HTML_PATTERN, '.xml': HTML_PATTERN, '.svg': HTML_PATTERN, '.vue': HTML_PATTERN, '.svelte': HTML_PATTERN,
    # SQL
    '.sql': SQL_PATTERN,
    # Lua
    '.lua': LUA_PATTERN
}

def get_git_root():
    try:
        root = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], stderr=subprocess.DEVNULL).decode('utf-8').strip()
        return root
    except subprocess.CalledProcessError:
        return None

def get_head_content(filepath):
    try:
        # Get content from HEAD. 
        # git show HEAD:path works with relative paths from the root or current dir usually.
        content = subprocess.check_output(['git', 'show', f'HEAD:{filepath}'], stderr=subprocess.DEVNULL)
        return content.decode('utf-8', errors='replace')
    except subprocess.CalledProcessError:
        return None

def strip_comments(text, ext):
    pattern_str = EXTENSION_MAP.get(ext)
    if not pattern_str:
        return text # Unknown extension, return as is (normalization will just be whitespace collapse)
    
    pattern = re.compile(pattern_str)
    
    def replacer(match):
        s = match.group(0)
        # Identify if it is a comment
        # Common comment starters in our regexes: #, //, /*, <!--, --, {/*
        if s.startswith('#') or s.startswith('//') or s.startswith('/*') or s.startswith('<!--') or s.startswith('--') or s.startswith('{/*'):
            return ""
        return s
        
    return pattern.sub(replacer, text)

def normalize(text, ext):
    """
    Normalize text by removing comments and all whitespace.
    This reduces the text to its semantic core.
    """
    text_no_comments = strip_comments(text, ext)
    return re.sub(r'\s+', '', text_no_comments)

def should_restore(old_chunk, new_chunk, ext):
    """
    Decide if we should restore old_chunk (undo the change).
    We restore if the semantic code (normalized) is identical.
    
    This logic covers:
    1. Deleted comments/whitespace (Old has content, New is empty/smaller, Norms equal).
    2. Pure reformatting (Old and New differ only in whitespace layout, Norms equal).
    3. Added comments/whitespace (Old is empty/smaller, New has content, Norms equal).
    
    In all cases, if the code means the same thing, we prefer the original (Old) version
    to keep the diff clean.
    """
    norm_old = normalize(old_chunk, ext)
    norm_new = normalize(new_chunk, ext)
    
    return norm_old == norm_new

def process_file(filepath):
    if not os.path.exists(filepath):
        print(f"Skipping {filepath}: File not found.")
        return

    # Fetch original content from git
    old_content = get_head_content(filepath)
    if old_content is None:
        print(f"Skipping {filepath}: Not tracked or new file.")
        return

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            new_content = f.read()
    except UnicodeDecodeError:
        print(f"Skipping {filepath}: Binary or non-utf8.")
        return

    ext = os.path.splitext(filepath)[1].lower()
    
    # We use splitlines(keepends=True) to preserve exact line endings for reconstruction
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    
    matcher = difflib.SequenceMatcher(None, old_lines, new_lines)
    
    output_lines = []
    changes_count = 0
    
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        old_chunk = "".join(old_lines[i1:i2])
        new_chunk = "".join(new_lines[j1:j2])
        
        if tag == 'equal':
            output_lines.append(old_chunk)
        else:
            # Check if we should undo the change (was it just noise, formatting, or comments?)
            if should_restore(old_chunk, new_chunk, ext):
                output_lines.append(old_chunk)
                changes_count += 1
            else:
                output_lines.append(new_chunk)
    
    if changes_count > 0:
        new_file_content = "".join(output_lines)
        # Only write if different
        if new_file_content != new_content:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_file_content)
            print(f"Cleaned {filepath}: Reverted {changes_count} chunks of noise.")
        else:
            print(f"Checked {filepath}: No effective changes to write.")
    else:
        # print(f"Checked {filepath}: No noise found.")
        pass

def main():
    parser = argparse.ArgumentParser(description="Undo 'noise' changes (whitespace/comments/formatting) from LLM output.")
    parser.add_argument('paths', nargs='+', help='Files or folders to process')
    args = parser.parse_args()
    
    git_root = get_git_root()
    if not git_root:
        print("Error: Not in a git repository.")
        sys.exit(1)
        
    for path in args.paths:
        if os.path.isfile(path):
            process_file(path)
        elif os.path.isdir(path):
            for root, dirs, files in os.walk(path):
                if '.git' in dirs:
                    dirs.remove('.git')
                for file in files:
                    process_file(os.path.join(root, file))
        else:
            print(f"Warning: {path} is not a file or directory.")

if __name__ == "__main__":
    main()