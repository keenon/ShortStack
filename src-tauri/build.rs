fn main() {
    println!("cargo:rerun-if-changed=src/cpp/tetgen.cxx");
    println!("cargo:rerun-if-changed=src/cpp/bindings.cpp");
    println!("cargo:rerun-if-changed=src/cpp/tetgen.h");
    println!("cargo:rerun-if-changed=src/cpp/predicates.cxx");

    cc::Build::new()
        .cpp(true) // Switch to C++ compiler
        .file("src/cpp/tetgen.cxx")
        .file("src/cpp/predicates.cxx")
        .file("src/cpp/bindings.cpp")
        .flag("-DTETLIBRARY") // Required macro for TetGen
        .flag("/O2") // Optimization (Windows)
        .flag("-O3") // Optimization (Linux/Mac)
        .compile("tetgen_lib");
    tauri_build::build()
}
