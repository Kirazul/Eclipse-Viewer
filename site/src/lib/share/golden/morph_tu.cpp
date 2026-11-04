// The real Morph.cpp, compiled unedited, plus the one door a harness needs: the barber's
// chair is entered from a client packet, and there is no client here. Everything the
// tests see after that door is the file's own code.
#include "Morph.cpp"

namespace wow {
namespace ec {
namespace mo {

void HarnessEnterChair() { EnterBarberHold(); }

}  // namespace mo
}  // namespace ec
}  // namespace wow
