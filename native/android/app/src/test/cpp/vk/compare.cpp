// Compares two PPM renders of the same view: the mean channel difference and the share of pixels
// with a channel off by more than 8 (the GLES render's own agreement measure, render.cpp compare).
//   compare <label> <a.ppm> <b.ppm> <max share over 8> <max mean>     exit 0 within both limits
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

namespace {

bool readPpm(const std::string &path, int &w, int &h, std::vector<unsigned char> &rgb) {
    std::ifstream in(path, std::ios::binary);
    std::string magic;
    int max = 0;
    in >> magic >> w >> h >> max;
    in.get();
    if (!in || magic != "P6" || max != 255 || w <= 0 || h <= 0)
        return false;
    rgb.resize(size_t(w) * size_t(h) * 3);
    in.read(reinterpret_cast<char *>(rgb.data()), std::streamsize(rgb.size()));
    return bool(in);
}

} // namespace

int main(int argc, char **argv) {
    if (argc != 6) {
        std::fprintf(stderr,
                     "usage: compare <label> <a.ppm> <b.ppm> <max share over 8> <max mean>\n");
        return 2;
    }
    int aw = 0, ah = 0, bw = 0, bh = 0;
    std::vector<unsigned char> a, b;
    if (!readPpm(argv[2], aw, ah, a) || !readPpm(argv[3], bw, bh, b)) {
        std::printf("%s: FAIL unreadable image\n", argv[1]);
        return 1;
    }
    if (aw != bw || ah != bh) {
        std::printf("%s: FAIL sizes %dx%d and %dx%d\n", argv[1], aw, ah, bw, bh);
        return 1;
    }
    size_t n = size_t(aw) * size_t(ah), bad = 0, lit = 0;
    double sum = 0;
    for (size_t i = 0; i < n; i++) {
        int worst = 0;
        for (int c = 0; c < 3; c++) {
            const int e = std::abs(int(a[i * 3 + c]) - int(b[i * 3 + c]));
            sum += e;
            worst = std::max(worst, e);
        }
        bad += worst > 8;
        lit += (b[i * 3] | b[i * 3 + 1] | b[i * 3 + 2]) != 0;
    }
    const double mean = sum / double(n * 3), over8 = double(bad) / double(n);
    const double maxOver8 = std::atof(argv[4]), maxMean = std::atof(argv[5]);
    const bool ok = over8 <= maxOver8 && mean <= maxMean && lit * 2 >= n;
    std::printf("%s: mean %.3f (limit %.3f), %.3f%% pixels > 8 (limit %.3f%%), %.1f%% lit: %s\n",
                argv[1], mean, maxMean, over8 * 100, maxOver8 * 100, double(lit) * 100 / double(n),
                ok ? "ok" : "FAIL");
    return ok ? 0 : 1;
}
