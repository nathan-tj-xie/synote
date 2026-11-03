// PROTOTYPE：Tauri 外壳，笔记库路径来自 SYNOTE_VAULT
use std::path::{Path, PathBuf};

fn vault() -> PathBuf {
    std::env::var("SYNOTE_VAULT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.vault-10k"))
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if e.file_name() == ".git" { continue; }
        if p.is_dir() { walk(&p, root, out); }
        else if p.extension().is_some_and(|x| x == "md") {
            out.push(p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
        }
    }
}

#[derive(serde::Serialize)]
struct Listing { root: String, files: Vec<String> }

#[tauri::command]
fn list_vault() -> Listing {
    let root = vault();
    let mut files = Vec::new();
    walk(&root, &root, &mut files);
    files.sort();
    Listing { root: root.to_string_lossy().into(), files }
}

#[tauri::command]
fn read_note(rel: String) -> Result<String, String> {
    std::fs::read_to_string(vault().join(rel)).map_err(|e| e.to_string())
}

#[tauri::command]
fn log(msg: String) { println!("[stat] {msg}"); }

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_vault, read_note, log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
