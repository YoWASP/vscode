from amaranth import *
from amaranth.lib import wiring
from amaranth.lib.wiring import In, Out


class Blinky(wiring.Component):
    led: Out(1)

    def __init__(self, frequency):
        self.frequency = frequency

        super().__init__()

    def elaborate(self, platform):
        m = Module()
        count = Signal(range(self.frequency // 2))
        with m.If(count == self.frequency // 2 - 1):
            m.d.sync += self.led.eq(~self.led)
            m.d.sync += count.eq(0)
        with m.Else():
            m.d.sync += count.eq(count + 1)
        return m


if __name__ == '__main__':
    from amaranth.back import rtlil

    with open('top.il', 'w') as f:
        f.write(rtlil.convert(Blinky(25_000_000)))
