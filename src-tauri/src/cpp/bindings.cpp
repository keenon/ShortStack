#include "tetgen.h"
#include <cstring> // for memcpy

extern "C" {
    // We define a struct to hold the result pointers that we manually allocated.
    struct MeshResult {
        double* points;
        int num_points;
        int* tetrahedra;
        int num_tetrahedra;
    };

    MeshResult* tetrahedralize_mesh(double* in_vertices, int num_vertices, int* in_faces, int num_faces) {
        tetgenio in, out;
        
        // 1. Setup Input (same as before)
        in.firstnumber = 0;
        in.numberofpoints = num_vertices;
        in.pointlist = new REAL[in.numberofpoints * 3];
        for(int i=0; i < num_vertices * 3; i++) in.pointlist[i] = in_vertices[i];

        in.numberoffacets = num_faces;
        in.facetlist = new tetgenio::facet[in.numberoffacets];
        in.facetmarkerlist = new int[in.numberoffacets];
        
        for(int i = 0; i < num_faces; i++) {
            tetgenio::facet *f = &in.facetlist[i];
            f->numberofpolygons = 1;
            f->polygonlist = new tetgenio::polygon[1];
            f->polygonlist[0].numberofvertices = 3;
            f->polygonlist[0].vertexlist = new int[3];
            f->polygonlist[0].vertexlist[0] = in_faces[i*3];
            f->polygonlist[0].vertexlist[1] = in_faces[i*3+1];
            f->polygonlist[0].vertexlist[2] = in_faces[i*3+2];
            in.facetmarkerlist[i] = 0; 
        }

        // 2. Run TetGen
        tetgenbehavior b;
        b.parse_commandline((char*)"pqz"); 
        tetrahedralize(&b, &in, &out);

        // 3. Persist Data
        // We allocate a MeshResult on the heap
        MeshResult* result = new MeshResult();
        result->num_points = out.numberofpoints;
        result->num_tetrahedra = out.numberoftetrahedra;

        // DEEP COPY the data from TetGen to our own buffers
        // This ensures it survives even when 'out' is destroyed
        result->points = new double[out.numberofpoints * 3];
        std::memcpy(result->points, out.pointlist, out.numberofpoints * 3 * sizeof(double));

        result->tetrahedra = new int[out.numberoftetrahedra * 4];
        std::memcpy(result->tetrahedra, out.tetrahedronlist, out.numberoftetrahedra * 4 * sizeof(int));

        return result; 
    }

    void free_mesh_result(MeshResult* result) {
        if (result != nullptr) {
            delete[] result->points;
            delete[] result->tetrahedra;
            delete result; // Delete the struct itself
        }
    }
}