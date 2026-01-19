#include "tetgen.h"
#include <cstring>
#include <new> // for std::bad_alloc

extern "C" {
    // Alignment-safe struct (Pointers first)
    struct MeshResult {
        double* points;
        int* tetrahedra;
        int num_points;
        int num_tetrahedra;
    };

    MeshResult* tetrahedralize_mesh(double* in_vertices, int num_vertices, int* in_faces, int num_faces, char* options) {
        // WRAP IN TRY-CATCH to prevent 0xc0000409 (Fast Fail)
        try {
            tetgenio in, out;
            
            // --- Setup Input Points ---
            in.firstnumber = 0;
            in.numberofpoints = num_vertices;
            in.pointlist = new REAL[in.numberofpoints * 3];
            for(int i=0; i < num_vertices * 3; i++) {
                in.pointlist[i] = (REAL)in_vertices[i];
            }

            // --- Setup Input Facets ---
            in.numberoffacets = num_faces;
            in.facetlist = new tetgenio::facet[in.numberoffacets];
            in.facetmarkerlist = nullptr;
            in.numberofholes = 0;
            in.holelist = nullptr;
            in.numberofregions = 0;
            in.regionlist = nullptr;

            for(int i = 0; i < num_faces; i++) {
                tetgenio::facet *f = &in.facetlist[i];
                f->numberofpolygons = 1;
                f->polygonlist = new tetgenio::polygon[1];
                f->polygonlist[0].numberofvertices = 3;
                f->polygonlist[0].vertexlist = new int[3];
                
                f->polygonlist[0].vertexlist[0] = in_faces[i*3];
                f->polygonlist[0].vertexlist[1] = in_faces[i*3+1];
                f->polygonlist[0].vertexlist[2] = in_faces[i*3+2];
                
                f->numberofholes = 0;
                f->holelist = nullptr;
            }

            // --- Run TetGen ---
            tetgenbehavior b;
            
            // CRITICAL FIX: Use the passed options string
            // If options is null or empty, default to "pqz" safety check
            if (options != nullptr && options[0] != '\0') {
                b.parse_commandline(options);
            } else {
                b.parse_commandline((char*)"pqz");
            }
            
            tetrahedralize(&b, &in, &out);

            // --- Copy Output ---
            MeshResult* result = new MeshResult();
            result->points = nullptr;
            result->tetrahedra = nullptr;
            result->num_points = out.numberofpoints;
            result->num_tetrahedra = out.numberoftetrahedra;

            if (out.numberofpoints > 0) {
                result->points = new double[out.numberofpoints * 3];
                std::memcpy(result->points, out.pointlist, out.numberofpoints * 3 * sizeof(double));
            }

            if (out.numberoftetrahedra > 0) {
                result->tetrahedra = new int[out.numberoftetrahedra * 4];
                std::memcpy(result->tetrahedra, out.tetrahedronlist, out.numberoftetrahedra * 4 * sizeof(int));
            }

            return result;

        } catch (...) {
            // Catch ANY C++ exception to prevent app crash
            return nullptr;
        }
    }

    void free_mesh_result(MeshResult* result) {
        if (result != nullptr) {
            if (result->points) delete[] result->points;
            if (result->tetrahedra) delete[] result->tetrahedra;
            delete result;
        }
    }
}