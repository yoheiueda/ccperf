package main

import (
	"fmt"
	"math"
	"net/http"
	_ "net/http/pprof"
	"strconv"
	"strings"

	"github.com/hyperledger/fabric/core/chaincode/shim"
	pb "github.com/hyperledger/fabric/protos/peer"
)

var logger = shim.NewLogger("ccperf")

// CCPerf
type CCPerf struct {
	buffers map[int][]byte
}

func NewCCPerf() *CCPerf {
	ccperf := new(CCPerf)
	ccperf.buffers = make(map[int][]byte)

	for size := 1; size <= 65536; size *= 2 {
		ccperf.buffers[size] = make([]byte, size)
		for i := 0; i < len(ccperf.buffers[size]); i++ {
			ccperf.buffers[size][i] = byte(23 * i)
		}
	}
	return ccperf
}

func (ccperf *CCPerf) Init(stub shim.ChaincodeStubInterface) pb.Response {

	_, _ = stub.GetFunctionAndParameters()

	return shim.Success(nil)
}

func (ccperf *CCPerf) Invoke(stub shim.ChaincodeStubInterface) pb.Response {
	logger.Debug("CCPerf.Invoke is called")
	defer logger.Debug("CCPerf.Invoke returns")

	function, args := stub.GetFunctionAndParameters()

	logger.Debugf("function name: %s", function)

	switch function {
	case "populate":
		return ccperf.runPopulate(stub, args)
	case "empty":
		return ccperf.runEmpty(stub, args)
	case "putstate":
		return ccperf.runPutState(stub, args)
	case "getstate":
		return ccperf.runGetState(stub, args)
	case "mix":
		return ccperf.runMix(stub, args)
	case "invoke_chaincode":
		return ccperf.runInvokeChaincode(stub, args)
	case "floating_point":
		return ccperf.runPutState(stub, args)
	}

	msg := fmt.Sprintf("Unknown function name: %s", function)
	logger.Error(msg)
	return shim.Error(msg)
}

func (ccperf *CCPerf) runPopulate(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 3 {
		msg := fmt.Sprintf("Incorrenct number of arguments. Expecting 3, recieved %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	start, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	num, err := strconv.Atoi(args[1])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	size, err := strconv.Atoi(args[2])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	buffer, ok := ccperf.buffers[size]
	if !ok {
		msg := fmt.Sprintf("Incorrenct buffer size specified.　Recieved %d", size)
		logger.Error(msg)
		return shim.Error(msg)
	}

	for i := start; i < num; i++ {
		key := "DATAKEY_" + strconv.Itoa(i)
		err = stub.PutState(key, buffer)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runPutState(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 3 {
		msg := fmt.Sprintf("Incorrenct number of arguments. Expecting 3, recieved %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	size, err := strconv.Atoi(args[1])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	key := args[2]

	buffer, ok := ccperf.buffers[size]
	if !ok {
		msg := fmt.Sprintf("Incorrenct buffer size specified.　Recieved %d", size)
		logger.Error(msg)
		return shim.Error(msg)
	}

	for i := 0; i < num; i++ {
		err = stub.PutState(key+"_"+strconv.Itoa(i), buffer)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runGetState(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 3 {
		msg := fmt.Sprintf("Incorrenct number of arguments. Expecting 1, recieved %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	max, err := strconv.Atoi(args[1])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	base := 0
	flag := false
	s := strings.Split(args[3], "_")
	if len(s) == 6 {
		x1, err1 := strconv.Atoi(s[3])
		x2, err2 := strconv.Atoi(s[4])
		x3, err3 := strconv.Atoi(s[5])
		if err1 != nil && err2 != nil && err3 != nil {
			base = 1000151*x1 + 100207*x2 + 3001*x3
			flag = true
		}
	}
	if !flag {
		msg := fmt.Sprintf("Invalid key format: %s", args[3])
		logger.Error(msg)
		return shim.Error(msg)
	}

	for i := 0; i < num; i++ {
		key := "DATAKEY_" + strconv.Itoa((base+401*i)%max)
		logger.Debugf("GetState(%s)", key)
		_, err = stub.GetState(key)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runMix(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 4 {
		msg := fmt.Sprintf("Incorrenct number of arguments. Expecting 1, recieved %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	getArgs := []string{args[0], args[1], args[3]}
	res := ccperf.runGetState(stub, getArgs)
	if res.GetStatus() != 200 {
		return res
	}

	putArgs := []string{args[0], args[1], args[2]}
	return ccperf.runGetState(stub, putArgs)
}

func (ccperf *CCPerf) runInvokeChaincode(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 2 {
		msg := fmt.Sprintf("Incorrenct number of arguments. Expecting 2, recieved %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	chaincodeName := args[1]
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	chaincodeArgs := [][]byte{[]byte("empty")}

	for i := 0; i < num; i++ {
		res := stub.InvokeChaincode(chaincodeName, chaincodeArgs, "")
		if res.GetStatus() != 200 {
			msg := fmt.Sprintf("Failed to InvokeChaincode: %s", res.GetMessage())
			logger.Error(msg)
			return shim.Error(msg)
		}
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runEmpty(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 0 {
		msg := fmt.Sprintf("Incorrenct number of arguments. Expecting 0, recieved %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runFloatingPoint(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 1 {
		msg := fmt.Sprintf("Incorrenct number of arguments. Expecting 1, recieved %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	x := 1.0

	for i := 0; i < num; i++ {
		for j := 0; j < 10000000; i++ {
			x = math.Sin(x)
		}
	}

	return shim.Success([]byte(string(int(x))))
}

func (ccperf *CCPerf) runAllocation(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 2 {
		msg := fmt.Sprintf("Incorrenct number of arguments. Expecting 2, recieved %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	size, err := strconv.Atoi(args[1])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	var x, y []byte
	count := 0
	for i := 0; i < num; i++ {
		y = x
		x = make([]byte, size)
		x[size-1] = 1
		count += len(x) + len(y)
	}

	return shim.Success([]byte(string(count)))
}

func main() {
	go http.ListenAndServe("0.0.0.0:6060", nil)

	logger.SetLevel(shim.LogInfo)
	logger.Info("CCPerf chaincode started")
	defer logger.Info("CCPerf chaincode finished")

	ccperf := NewCCPerf()

	err := shim.Start(ccperf)
	if err != nil {
		logger.Errorf("Failed to start chaincode: %s", err)
	}
}
