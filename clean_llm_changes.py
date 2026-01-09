#!/usr/bin/env python3
import sys
import os
import subprocess
import difflib
import re
import argparse

# Regex patterns for stripping comments while preserving strings.
PYTHON_PATTERN = r'(\"\"\"[\s\S]*?\"\"\"|\'\'\'[\s\S]*?\'\'\'|\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|#.*)'
C_STYLE_PATTERN = r'(\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|//.*|/\*[\s\S]*?\*/)'
JSX_STYLE_PATTERN = r'(\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|//.*|/\*[\s\S]*?\*/|\{/\*[\s\S]*?\*\/\})'
HTML_PATTERN = r'(\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|<!--[\s\S]*?-->)'
SQL_PATTERN = r'(\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|/\*[\s\S]*?\*/|--.*)'
LUA_PATTERN = r'(\"(?:\\.|[^\\\"])*\"|\'(?:\\.|[^\\\'])*\'|--.*)'

EXTENSION_MAP = {
    '.py': PYTHON_PATTERN, '.pyw': PYTHON_PATTERN, '.rb': PYTHON_PATTERN, 
    '.sh': PYTHON_PATTERN, '.yaml': PYTHON_PATTERN, '.yml': PYTHON_PATTERN,
    '.toml': PYTHON_PATTERN, '.dockerfile': PYTHON_PATTERN,
    '.c': C_STYLE_PATTERN, '.cpp': C_STYLE_PATTERN, '.h': C_STYLE_PATTERN, '.hpp': C_STYLE_PATTERN,
    '.js': C_STYLE_PATTERN, '.ts': C_STYLE_PATTERN, '.java': C_STYLE_PATTERN, 
    '.cs': C_STYLE_PATTERN, '.go': C_STYLE_PATTERN, '.rs': C_STYLE_PATTERN,
    '.swift': C_STYLE_PATTERN, '.kt': C_STYLE_PATTERN, '.scala': C_STYLE_PATTERN, 
    '.dart': C_STYLE_PATTERN, '.php': C_STYLE_PATTERN, '.css': C_STYLE_PATTERN, 
    '.scss': C_STYLE_PATTERN, '.less': C_STYLE_PATTERN,
    '.jsx': JSX_STYLE_PATTERN, '.tsx': JSX_STYLE_PATTERN,
    '.html': HTML_PATTERN, '.xml': HTML_PATTERN, '.svg': HTML_PATTERN, 
    '.vue': HTML_PATTERN, '.svelte': HTML_PATTERN,
    '.sql': SQL_PATTERN, '.lua': LUA_PATTERN
}

def get_git_root():
    try:
        return subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], stderr=subprocess.DEVNULL).decode('utf-8').strip()
    except subprocess.CalledProcessError:
        return None

def get_head_content(filepath):
    try:
        content = subprocess.check_output(['git', 'show', f'HEAD:{filepath}'], stderr=subprocess.DEVNULL)
        return content.decode('utf-8', errors='replace')
    except subprocess.CalledProcessError:
        return None

def strip_comments(text, ext):
    pattern_str = EXTENSION_MAP.get(ext)
    if not pattern_str:
        return text
    
    pattern = re.compile(pattern_str)
    def replacer(match):
        s = match.group(0)
        # Common comment starters
        if any(s.startswith(p) for p in ['#', '//', '/*', '<!--', '--', '{/*']):
            return ""
        return s
    return pattern.sub(replacer, text)

def normalize(text, ext):
    """Normalize text by removing comments and all whitespace."""
    text_no_comments = strip_comments(text, ext)
    return re.sub(r'\s+', '', text_no_comments)

def should_restore(old_text, new_text, ext):
    """True if the code is semantically identical after stripping whitespace/comments."""
    return normalize(old_text, ext) == normalize(new_text, ext)

def process_file(filepath):
    if not os.path.exists(filepath):
        return

    old_content = get_head_content(filepath)
    if old_content is None:
        return

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            new_content = f.read()
    except UnicodeDecodeError:
        return

    ext = os.path.splitext(filepath)[1].lower()
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    
    matcher = difflib.SequenceMatcher(None, old_lines, new_lines)
    output_lines = []
    total_reverts = 0
    
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        old_chunk_lines = old_lines[i1:i2]
        new_chunk_lines = new_lines[j1:j2]
        old_chunk_str = "".join(old_chunk_lines)
        new_chunk_str = "".join(new_chunk_lines)

        if tag == 'equal':
            output_lines.extend(old_chunk_lines)
        
        # 1. Check if the entire chunk can be restored (pure formatting/comment change)
        elif should_restore(old_chunk_str, new_chunk_str, ext):
            output_lines.extend(old_chunk_lines)
            if old_chunk_str != new_chunk_str:
                total_reverts += 1
        
        # 2. If the chunk has real changes, check if specific lines within it 
        # only changed their leading whitespace/indentation.
        elif tag == 'replace' and len(old_chunk_lines) == len(new_chunk_lines):
            for o_line, n_line in zip(old_chunk_lines, new_chunk_lines):
                if should_restore(o_line, n_line, ext):
                    output_lines.append(o_line)
                    if o_line != n_line:
                        total_reverts += 1
                else:
                    output_lines.append(n_line)
        
        # 3. Otherwise, accept the new chunk
        else:
            output_lines.extend(new_chunk_lines)
    
    if total_reverts > 0:
        new_file_content = "".join(output_lines)
        if new_file_content != new_content:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_file_content)
            print(f"Cleaned {filepath}: Reverted {total_reverts} noisy changes.")

def main():
    parser = argparse.ArgumentParser(description="Undo whitespace/comment/indentation noise from Git diffs.")
    parser.add_argument('paths', nargs='+', help='Files or folders to process')
    args = parser.parse_args()
    
    if not get_git_root():
        print("Error: Not in a git repository.")
        sys.exit(1)
        
    for path in args.paths:
        if os.path.isfile(path):
            process_file(path)
        elif os.path.isdir(path):
            for root, _, files in os.walk(path):
                for file in files:
                    process_file(os.path.join(root, file))

if __name__ == "__main__":
    main()