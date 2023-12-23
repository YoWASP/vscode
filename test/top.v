module top(input clk25, output reg led);

    reg [23:0] count = 0;
    always @(posedge clk25) begin
        if (count == 24'd12500000)
            count <= 0;
        else
            count <= count + 1;
        if (count == 0)
            led <= ~led;
    end

endmodule
